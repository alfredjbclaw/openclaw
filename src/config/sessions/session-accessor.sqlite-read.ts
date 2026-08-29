import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  LatestTranscriptAssistantMessage,
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
  SessionTranscriptEventRow,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type SqliteTranscriptSnapshotRow = {
  eventJson: string;
  seq: number;
};

export type SqliteTranscriptStorageRow = SqliteTranscriptSnapshotRow & {
  createdAt: number;
};

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadTranscriptEventsSync(scope: SessionTranscriptReadScope): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      return loadTranscriptEventsFromDatabase(database, resolved.sessionId, fence?.beforeRawSeq);
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript fenced read",
    },
  );
}

/** Reads a complete transcript and its lifecycle snapshot from one SQLite read transaction. */
export function inspectTranscriptEventsSync(scope: SessionTranscriptReadScope): {
  events: TranscriptEvent[];
  snapshot: SessionStateDeleteSnapshot;
} {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => ({
      events: readTranscriptSnapshot(database, resolved.sessionId).events,
      snapshot: readSessionStateDeleteSnapshot(database.db, resolved.sessionId),
    }),
    {
      databaseLabel: database.path,
      operationLabel: "session transcript inspection",
    },
  );
}

/** Loads only the first transcript row for header metadata hot paths. */
export function loadTranscriptHeaderSync(scope: SessionTranscriptReadScope): unknown {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", resolved.sessionId)
      .orderBy("seq", "asc")
      .limit(1),
  );
  return row ? (JSON.parse(row.event_json) as TranscriptEvent) : undefined;
}

/** Newest transcript tail retained after both the row cap and the byte budget. */
type SqliteTranscriptTailWindow = {
  events: TranscriptEvent[];
  /** Oldest seq retained by the window; undefined when nothing was retained. */
  startSeq?: number;
  /**
   * Seqs inside the window that were skipped without being parsed because one
   * event alone exceeded the whole byte budget.
   */
  oversizedSeqs: number[];
  /** True when the byte budget dropped older events the row cap would have kept. */
  truncatedByBytes: boolean;
};

/**
 * Loads a bounded newest tail in storage order for hot-path accounting.
 *
 * Bounded twice: `maxEvents` caps rows and `maxBytes` caps the payload those
 * rows decode into. A row cap alone is not a memory bound, because one
 * persisted event carries arbitrary bytes, and this read is synchronous — an
 * oversized blob would stall the caller inside JSON.parse. Byte accounting
 * therefore happens in SQL, before any payload is materialized.
 */
export function loadTranscriptTailWindowSync(
  scope: SessionTranscriptReadScope,
  bounds: { maxEvents: number; maxBytes: number },
): SqliteTranscriptTailWindow {
  const limit = Number.isFinite(bounds.maxEvents) ? Math.max(0, Math.floor(bounds.maxEvents)) : 0;
  const byteBudget = Number.isFinite(bounds.maxBytes)
    ? Math.max(0, Math.floor(bounds.maxBytes))
    : 0;
  if (limit === 0 || byteBudget === 0) {
    return { events: [], oversizedSeqs: [], truncatedByBytes: false };
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  // Shares the current-turn read fence with loadTranscriptEventsSync: a bounded
  // tail must not expose the just-admitted user row that the unbounded reader
  // hides, or a caller that swaps readers silently gains the current turn.
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const sizes = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("seq")
          .select(sqliteTranscriptEventByteLength())
          .where("session_id", "=", resolved.sessionId)
          .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
          .orderBy("seq", "desc")
          .limit(limit),
      ).rows;
      const plan = planTranscriptTailByteWindow(sizes, byteBudget);
      if (plan.retainedSeqs.length === 0) {
        return {
          events: [],
          oversizedSeqs: plan.oversizedSeqs,
          truncatedByBytes: plan.truncatedByBytes,
        };
      }
      const events = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("event_json")
          .where("session_id", "=", resolved.sessionId)
          .where("seq", "in", plan.retainedSeqs)
          .orderBy("seq", "asc"),
      ).rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
      return {
        events,
        oversizedSeqs: plan.oversizedSeqs,
        startSeq: plan.retainedSeqs[plan.retainedSeqs.length - 1],
        truncatedByBytes: plan.truncatedByBytes,
      };
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript fenced tail read",
    },
  );
}

/**
 * Walks a newest-first row window and keeps the newest events that fit the
 * byte budget, mirroring how the JSONL loader keeps the file's last N bytes.
 *
 * An event larger than the entire budget can never fit, and JSON — unlike the
 * file loader's byte window — cannot be partially decoded. Such an event is
 * skipped unparsed and reported, rather than being allowed to stall the caller
 * or to empty the whole window.
 */
function planTranscriptTailByteWindow(
  rows: readonly { seq: number | bigint; event_bytes: number | bigint }[],
  byteBudget: number,
): { retainedSeqs: number[]; oversizedSeqs: number[]; truncatedByBytes: boolean } {
  const retainedSeqs: number[] = [];
  const oversizedSeqs: number[] = [];
  let usedBytes = 0;
  let truncatedByBytes = false;
  for (const row of rows) {
    const seq = coerceSqliteNumber(row.seq);
    const eventBytes = coerceSqliteNumber(row.event_bytes);
    if (eventBytes > byteBudget) {
      oversizedSeqs.push(seq);
      continue;
    }
    if (usedBytes + eventBytes > byteBudget) {
      truncatedByBytes = true;
      break;
    }
    usedBytes += eventBytes;
    retainedSeqs.push(seq);
  }
  return { oversizedSeqs, retainedSeqs, truncatedByBytes };
}

function sqliteTranscriptEventType() {
  return /* kysely-allow-raw: row type lives inside canonical transcript JSON. */ sql<string>`json_extract(event_json, '$.type')`;
}

function sqliteTranscriptEventByteLength() {
  // TEXT length() counts characters, so the payload must be measured as a BLOB.
  return /* kysely-allow-raw: stored event size must be measured in bytes, not characters. */ sql<number>`length(CAST(event_json AS BLOB))`.as(
    "event_bytes",
  );
}

/**
 * True when a branch-control row falls outside the tail window a caller holds.
 *
 * A tail with no leaf rows is ambiguous on its own: the transcript may be an
 * ordinary linear conversation, or its controls may simply sit outside the
 * window. Callers that project the tail must tell those apart, because a flat
 * projection of a severed branch history exposes abandoned branches. This
 * answers it with a bounded existence check rather than a full read.
 *
 * The window is described by what the caller actually retained, not by a row
 * cap: the byte budget can trim the window further than `maxEvents` would, and
 * probing the row cutoff would then answer about rows the caller never saw.
 * Rows skipped inside the window count as omitted for the same reason.
 */
export function transcriptTailOmitsBranchControlSync(
  scope: SessionTranscriptReadScope,
  window: { startSeq: number; omittedSeqs?: readonly number[] },
): boolean {
  const omittedSeqs = window.omittedSeqs ?? [];
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      // No fence is needed: every candidate row is older than the window the
      // caller retained, so it is already below any current-turn fence.
      const controlOutside = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", resolved.sessionId)
          .where((eb) =>
            eb.or([
              eb("seq", "<", window.startSeq),
              ...(omittedSeqs.length > 0 ? [eb("seq", "in", omittedSeqs)] : []),
            ]),
          )
          .where(sqliteTranscriptEventType(), "=", "leaf")
          .limit(1),
      ).rows;
      return controlOutside.length > 0;
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript branch-control probe",
    },
  );
}

/** Loads additive transcript rows after one durable sequence checkpoint. */
export function loadTranscriptEventRowsAfterSeqSync(
  scope: SessionTranscriptReadScope,
  afterSeq: number,
  throughSeq?: number,
): SessionTranscriptEventRow[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("transcript_events")
    .select(["event_json", "seq"])
    .where("session_id", "=", resolved.sessionId)
    .where("seq", ">", afterSeq);
  if (throughSeq !== undefined) {
    query = query.where("seq", "<=", throughSeq);
  }
  return executeSqliteQuerySync(database.db, query.orderBy("seq", "asc")).rows.map((row) => ({
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: coerceSqliteNumber(row.seq),
  }));
}

/** Reads one checkpoint row so incremental consumers can reject transcript rewrites. */
export function readTranscriptEventAtSeqSync(
  scope: SessionTranscriptReadScope,
  seq: number,
): SessionTranscriptEventRow | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", resolved.sessionId)
      .where("seq", "=", seq),
  );
  return row
    ? {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: coerceSqliteNumber(row.seq),
      }
    : undefined;
}

export function loadTranscriptEventsFromDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  beforeEventSeq?: number,
): TranscriptEvent[] {
  const db = getSessionKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc"),
  );
  // Array.from closes the iterator on parse failure; no live cursor escapes a fenced read.
  return Array.from(rows, (row) => JSON.parse(row.event_json) as TranscriptEvent);
}

export function readTranscriptSnapshot(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { events: TranscriptEvent[]; rows: SqliteTranscriptSnapshotRow[] } {
  const rows = readTranscriptEventRows(database, sessionId);
  return {
    events: rows.map((row) => JSON.parse(row.eventJson) as TranscriptEvent),
    rows,
  };
}

/** Reads transcript rows without decoding payloads for snapshot comparison. */
export function readTranscriptEventRows(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SqliteTranscriptSnapshotRow[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => ({
    eventJson: row.event_json,
    seq: coerceSqliteNumber(row.seq),
  }));
}

/** Reads exact transcript storage rows for guarded doctor rewrites. */
export function readTranscriptStorageRows(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SqliteTranscriptStorageRow[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["created_at", "event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => ({
    createdAt: coerceSqliteNumber(row.created_at),
    eventJson: row.event_json,
    seq: coerceSqliteNumber(row.seq),
  }));
}

function sqliteTranscriptJsonlByteSize() {
  // octet_length reads column metadata; casting to BLOB loads every overflow payload first.
  return /* kysely-allow-raw: JSONL size includes event bytes plus newline separators. */ sql<number>`COALESCE(SUM(OCTET_LENGTH(event_json)), 0)
    + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END`.as("size_bytes");
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsSync(scope: SessionTranscriptReadScope): SessionTranscriptStats {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.count<number>("seq").as("event_count"),
        eb.fn.max<number>("seq").as("max_seq"),
        sqliteTranscriptJsonlByteSize(),
      ])
      .where("session_id", "=", resolved.sessionId),
  );
  const session = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where("session_id", "=", resolved.sessionId),
  );
  return {
    eventCount: row?.event_count ?? 0,
    ...(session?.transcript_updated_at !== null && session?.transcript_updated_at !== undefined
      ? { lastMutationAtMs: session.transcript_updated_at }
      : {}),
    ...(session?.transcript_observed_at !== null && session?.transcript_observed_at !== undefined
      ? { lastObservedMutationAtMs: session.transcript_observed_at }
      : {}),
    maxSeq: row?.max_seq ?? 0,
    sizeBytes: row?.size_bytes ?? 0,
  };
}

/** Reads the latest visible assistant text from SQLite transcript rows in reverse order. */
export function loadLatestAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
        database,
        ...resolved,
      })?.beforeRawSeq;
      const rows = iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events as te")
          .innerJoin("transcript_event_identities as ti", (join) =>
            join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
          )
          .select("te.event_json as event_json")
          .where("te.session_id", "=", resolved.sessionId)
          .where("ti.event_type", "=", "message")
          .$if(beforeEventSeq !== undefined, (query) => query.where("ti.seq", "<", beforeEventSeq!))
          .orderBy("ti.seq", "desc"),
      );
      for (const row of rows) {
        const latest = parseLatestAssistantMessageEvent(row.event_json, options);
        if (!latest) {
          continue;
        }
        const text = parseLatestAssistantText(latest);
        if (text) {
          return text;
        }
      }
      return undefined;
    },
    {
      databaseLabel: database.path,
      operationLabel: "latest assistant fenced read",
    },
  );
}

function parseLatestAssistantText(
  latest: LatestTranscriptAssistantMessage,
): LatestTranscriptAssistantText | undefined {
  const message = latest.message as { timestamp?: unknown };
  const text = extractAssistantPhaseText(latest.message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(latest.id ? { id: latest.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function parseLatestAssistantMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: { model?: unknown; provider?: unknown; role?: unknown; timestamp?: unknown };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

/** Finds the newest transcript record accepted by the matcher without parsing older rows. */
export async function findTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): Promise<{ event: TranscriptEvent } | undefined> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return findTranscriptEventInDatabase(database, resolved.sessionId, match);
}

export function findTranscriptEventInDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const db = getSessionKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc"),
  );
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed rows are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

export function readTranscriptEventMessage(
  event: TranscriptEvent,
): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

export function readTranscriptEventId(event: TranscriptEvent): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}
