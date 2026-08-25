/**
 * Reads CLI session history from the SQLite transcript store.
 *
 * Split out of session-history.ts, which owns the legacy file reader and the
 * prompt rendering; both readers feed the same downstream projection.
 */
import {
  loadTranscriptTailWindowSync,
  transcriptTailOmitsBranchControlSync,
} from "../../config/sessions/session-accessor.js";
import { selectSessionTranscriptLeafControlledPath } from "../../config/sessions/transcript-tree.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { MAX_CLI_SESSION_HISTORY_BYTES } from "../../shared/session-transcript-limits.js";
import { migrateSessionEntries, type FileEntry } from "../sessions/session-manager.js";
import { cliBackendLog } from "./log.js";

type StoreReadParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

function toReadScope(params: StoreReadParams) {
  return {
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.config?.session?.store ? { storePath: params.config.session.store } : {}),
  };
}

/**
 * Narrows a persisted transcript event to a session entry.
 *
 * Transcript events are stored as opaque JSON, so the store reader has to
 * establish the discriminant every `FileEntry` carries before the migration and
 * the `type` filter below may touch it. A row that is not a discriminated
 * object cannot be either, and dropping it here is what keeps a malformed row
 * from reaching `migrateSessionEntries` as a bare `null`.
 */
function isPersistedFileEntry(event: unknown): event is FileEntry {
  return (
    typeof event === "object" && event !== null && "type" in event && typeof event.type === "string"
  );
}

/** Reads session entries from the transcript store when no legacy file is present. */
export async function loadCliSessionEntriesFromStore(
  params: StoreReadParams,
  maxEntries: number,
  projectLatestCliHistoryBoundary: (entries: unknown[]) => unknown[],
): Promise<unknown[]> {
  try {
    // A SQLite session store keeps the whole conversation, so this reads the
    // newest tail only: an unbounded read would load a long-lived session's
    // full history into memory and into the reseed prompt. The row cap is not
    // a memory bound on its own — one persisted event carries arbitrary bytes
    // — so this read carries the same 5 MiB ceiling the file loader applies to
    // its window, enforced in SQL before any payload is decoded.
    const window = loadTranscriptTailWindowSync(toReadScope(params), {
      maxBytes: MAX_CLI_SESSION_HISTORY_BYTES,
      maxEvents: maxEntries,
    });
    if (window.truncatedByBytes) {
      cliBackendLog.warn(
        `cli session history transcript-store tail truncated to last ${MAX_CLI_SESSION_HISTORY_BYTES} bytes: ${params.sessionId}`,
      );
    }
    if (window.oversizedSeqs.length > 0) {
      // A partial JSON value cannot be decoded the way a partial file window
      // can, so an event that alone exceeds the budget is skipped unparsed.
      cliBackendLog.warn(
        `cli session history transcript-store skipped ${window.oversizedSeqs.length} transcript event(s) larger than ${MAX_CLI_SESSION_HISTORY_BYTES} bytes: ${params.sessionId}`,
      );
    }
    if (window.events.length === 0 || window.startSeq === undefined) {
      return [];
    }
    // filter() also yields the fresh array `migrateSessionEntries` mutates in place.
    const entries = window.events.filter(isPersistedFileEntry);
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    if (sessionEntries.length === 0) {
      return [];
    }
    const leafControlled = selectSessionTranscriptLeafControlledPath(sessionEntries);
    if (
      !leafControlled &&
      transcriptTailOmitsBranchControlSync(toReadScope(params), {
        omittedSeqs: window.oversizedSeqs,
        startSeq: window.startSeq,
      })
    ) {
      // A transcript with no branch controls anywhere is an ordinary linear
      // conversation and projects flat safely. This reader returns a bounded
      // TAIL, though, so the controls may instead sit above the cut — and a flat
      // projection of that would feed abandoned branches into the reseed prompt.
      // The probe distinguishes the two; refuse only the severed case. Mirrors
      // the file loader's oversized-tail guard. The probe is given the window
      // the byte budget actually retained, so a byte-trimmed cut cannot project
      // a severed branch flat.
      cliBackendLog.warn(
        "cli session history transcript-store tail omits its branch controls; refusing to reseed from it",
      );
      return [];
    }
    return projectLatestCliHistoryBoundary(leafControlled ?? sessionEntries);
  } catch (error) {
    cliBackendLog.warn(
      `cli session history transcript-store load failed: ${formatErrorMessage(error)}`,
    );
    return [];
  }
}
