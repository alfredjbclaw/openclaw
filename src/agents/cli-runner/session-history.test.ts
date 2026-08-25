import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
// Covers CLI session transcript loading and reseeding boundaries.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MAX_CLI_SESSION_HISTORY_BYTES } from "../../shared/session-transcript-limits.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "../harness/hook-history.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";

const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
const RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  filePath?: string;
  messages?: string[];
}): string {
  // Tests write the canonical session envelope first so loaders exercise the
  // same JSONL record order used by persisted OpenClaw sessions.
  const sessionFile =
    params.filePath ??
    path.join(
      params.rootDir,
      "agents",
      params.agentId ?? "main",
      "sessions",
      `${params.sessionId}.jsonl`,
    );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    })}\n`,
    "utf-8",
  );
  for (const [index, message] of (params.messages ?? []).entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: "user",
          content: message,
          timestamp: index + 1,
        },
      })}\n`,
      "utf-8",
    );
  }
  return sessionFile;
}

function createOversizedSessionTranscript(rootDir: string, sessionId: string): string {
  return createSessionTranscript({
    rootDir,
    sessionId,
    messages: ["x".repeat(MAX_CLI_SESSION_HISTORY_BYTES), "tail history"],
  });
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectMessageFields(value: unknown, expected: { role: string; content?: unknown }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toEqual(expected.content);
  }
}

function expectCompactionSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "compaction summary");
  expect(message.role).toBe("compactionSummary");
  expect(message.summary).toBe(summary);
}

function expectCustomMessage(value: unknown, expected: { customType: string; content: string }) {
  const message = requireRecord(value, "custom message");
  expect(message.role).toBe("custom");
  expect(message.customType).toBe(expected.customType);
  expect(message.content).toBe(expected.content);
}

function expectBranchSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "branch summary");
  expect(message.role).toBe("branchSummary");
  expect(message.summary).toBe(summary);
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

describe("loadCliSessionHistoryMessages", () => {
  it("reads the canonical session transcript instead of an arbitrary external path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-test",
      filePath: path.join(outsideDir, "stolen.jsonl"),
      messages: ["stolen history"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        // The caller-supplied path is intentionally hostile here; canonical state
        // resolution prevents a stale or external file from becoming hook input.
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-test",
          sessionFile: outsideFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "expected history" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("detects canonical transcripts when callers pass stale external session paths", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-test",
      filePath: path.join(outsideDir, "stale.jsonl"),
      messages: ["stale history"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          hasCliSessionTranscript({
            sessionId: "session-test",
            sessionFile: outsideFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded history window", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-bounded",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-bounded",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
        expectMessageFields(history[0], { role: "user", content: "msg-25" });
        expectMessageFields(history.at(-1), {
          role: "user",
          content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loads only the branch selected by transcript leaf controls", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-leaf-control",
      messages: ["active root"],
    });
    fs.appendFileSync(
      sessionFile,
      [
        {
          type: "message",
          id: "side-entry",
          parentId: "msg-0",
          timestamp: new Date(2).toISOString(),
          message: { role: "assistant", content: "side delivery", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(3).toISOString(),
          targetId: "msg-0",
        },
        {
          type: "message",
          id: "active-tail",
          parentId: "msg-0",
          timestamp: new Date(4).toISOString(),
          message: { role: "assistant", content: "active tail", timestamp: 4 },
        },
        {
          type: "metadata",
          id: "opaque-after-active-tail",
          parentId: "side-entry",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-leaf-control",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(2);
        expectMessageFields(history[0], { role: "user", content: "active root" });
        expectMessageFields(history[1], {
          role: "assistant",
          content: [{ type: "text", text: "active tail" }],
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps complete history for context-engine snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-context-engine-history",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionContextEngineMessages({
          sessionId: "session-context-engine-history",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES + 25);
        expectMessageFields(history[0], { role: "user", content: "msg-0" });
        expectMessageFields(history.at(-1), {
          role: "user",
          content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the latest compaction summary and complete tail for context-engine snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-context-engine-compacted",
      messages: ["old ask"],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compact-1",
        timestamp: new Date(2).toISOString(),
        summary: "Earlier compacted context",
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "custom_message",
        id: "custom-tail",
        parentId: "compaction-1",
        timestamp: new Date(3).toISOString(),
        customType: "runtime-note",
        content: "tail custom context",
        display: false,
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "branch_summary",
        id: "branch-tail",
        parentId: "custom-tail",
        fromId: "custom-tail",
        timestamp: new Date(4).toISOString(),
        summary: "tail branch context",
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "msg-tail",
        parentId: "branch-tail",
        timestamp: new Date(5).toISOString(),
        message: {
          role: "assistant",
          content: "tail answer",
          timestamp: 5,
        },
      })}\n`,
      "utf-8",
    );

    try {
      // Context-engine snapshots need the compacted summary plus the exact tail
      // records so downstream context reconstruction preserves branch metadata.
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionContextEngineMessages({
          sessionId: "session-context-engine-compacted",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(4);
        expectCompactionSummary(history[0], "Earlier compacted context");
        expectCustomMessage(history[1], {
          customType: "runtime-note",
          content: "tail custom context",
        });
        expectBranchSummary(history[2], "tail branch context");
        expectMessageFields(history[3], {
          role: "assistant",
          content: [{ type: "text", text: "tail answer" }],
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked transcripts instead of following them outside the sessions directory", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    const canonicalSessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-symlink.jsonl",
    );
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-symlink",
      filePath: path.join(outsideDir, "outside.jsonl"),
      messages: ["stolen history"],
    });
    fs.mkdirSync(path.dirname(canonicalSessionFile), { recursive: true });
    fs.symlinkSync(outsideFile, canonicalSessionFile);

    try {
      await withCliSessionState(stateDir, async () => {
        // lstat rejection is the security boundary; following the link would make
        // arbitrary filesystem content eligible for prompt/history injection.
        expect(
          await loadCliSessionHistoryMessages({
            sessionId: "session-symlink",
            sessionFile: canonicalSessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).toStrictEqual([]);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("loads a bounded tail from oversized transcript files", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createOversizedSessionTranscript(stateDir, "session-oversized");
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-oversized",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "tail history" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history truncated to last"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the opened file size when the transcript shrinks after stat", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionFile = createOversizedSessionTranscript(stateDir, "session-oversized-shrink");
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    // Report a stale size whose bounded-read offset is beyond the real EOF,
    // as when the CLI compacts the transcript between the path stat and open.
    const realFspStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target).endsWith("session-oversized-shrink.jsonl")) {
        const stats = await realFspStat(target as Parameters<typeof realFspStat>[0]);
        // Proxy keeps the Stats prototype (isFile etc.) and only inflates the
        // reported size past EOF; spreading a Stats instance would drop both.
        return new Proxy(stats, {
          get: (obj, prop, receiver) =>
            prop === "size"
              ? obj.size + MAX_CLI_SESSION_HISTORY_BYTES + 4096
              : Reflect.get(obj, prop, receiver),
        });
      }
      return realFspStat(target as Parameters<typeof realFspStat>[0], ...rest);
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-oversized-shrink",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "tail history" });
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("cli session history parse failed"),
        );
      });
    } finally {
      statSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("skips oversized transcript tails when branch controls were dropped", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-oversized-branch.jsonl",
    );
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session-oversized-branch",
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "root", timestamp: 1 },
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(2).toISOString(),
          targetId: "root",
        }),
        JSON.stringify({
          type: "message",
          id: "filler",
          parentId: "root",
          timestamp: new Date(3).toISOString(),
          message: {
            role: "assistant",
            content: "x".repeat(MAX_CLI_SESSION_HISTORY_BYTES),
            timestamp: 3,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "side-entry",
          parentId: "root",
          timestamp: new Date(4).toISOString(),
          message: { role: "assistant", content: "side history", timestamp: 4 },
        }),
        JSON.stringify({
          type: "message",
          id: "active-tail",
          parentId: "root",
          timestamp: new Date(5).toISOString(),
          message: { role: "assistant", content: "active history", timestamp: 5 },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          loadCliSessionHistoryMessages({
            sessionId: "session-oversized-branch",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toStrictEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history truncated tail skipped"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("warns when transcript parsing fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-invalid-jsonl.jsonl",
    );
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{not-json}\n", "utf-8");

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          loadCliSessionHistoryMessages({
            sessionId: "session-invalid-jsonl",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toStrictEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history parse failed:"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("honors custom session store roots when resolving hook history transcripts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const customStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-store-"));
    const storePath = path.join(customStoreDir, "sessions.json");
    fs.writeFileSync(storePath, "{}", "utf-8");
    const sessionFile = createSessionTranscript({
      rootDir: customStoreDir,
      sessionId: "session-custom-store",
      filePath: path.join(customStoreDir, "session-custom-store.jsonl"),
      messages: ["custom store history"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-custom-store",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          config: {
            session: {
              store: storePath,
            },
          },
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "custom store history" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customStoreDir, { recursive: true, force: true });
    }
  });
});

describe("loadCliSessionReseedMessages", () => {
  it("does not reseed fresh CLI sessions from raw transcript history before compaction", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-no-compaction",
      messages: ["raw secret", "large context"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        expect(
          await loadCliSessionReseedMessages({
            sessionId: "session-no-compaction",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).toStrictEqual([]);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds safe invalidated sessions from a bounded raw message tail when explicitly opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-opt-in-raw-tail",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `raw-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
        // Raw transcript reseed is deliberately opt-in and bounded so missing CLI
        // sessions do not replay an unbounded pre-compaction transcript.
        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-opt-in-raw-tail",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "missing-transcript",
        });
        expect(reseed).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
        expectMessageFields(reseed[0], { role: "user", content: "raw-25" });
        expectMessageFields(reseed.at(-1), {
          role: "user",
          content: `raw-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
        });
        expect(requireRecord(reseed[0], "first raw reseed message").timestamp).toBe(
          "1970-01-01T00:00:00.026Z",
        );
        const prompt = buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" });
        expect(prompt).toContain("[1970-01-01T00:00:00.026Z] User: raw-25");
        expect(prompt).toContain(RESEED_CURRENCY_GUIDANCE);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds from the transcript store when no legacy session file exists", async () => {
    // SQLite session stores never write a per-session .jsonl, so a loader that only
    // reads that file returns no history at all and reseed silently carries nothing.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-only";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath },
      [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        {
          type: "message",
          id: "store-only-1",
          parentId: null,
          timestamp: "2026-05-01T00:00:01.000Z",
          message: { role: "user", content: "store-only history" },
        },
      ],
    );

    try {
      await withCliSessionState(stateDir, async () => {
        expect(fs.existsSync(sessionFile)).toBe(false);
        const reseed = await loadCliSessionReseedMessages({
          sessionId,
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          config: { session: { store: storePath } } as OpenClawConfig,
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "missing-transcript",
        });
        expect(reseed).toHaveLength(1);
        expectMessageFields(reseed[0], { role: "user", content: "store-only history" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reads only the newest bounded tail from an over-bound transcript store", async () => {
    // A long-lived SQLite session keeps every turn, so an unbounded store read
    // would pull the whole conversation into memory and into the reseed prompt.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-overbound";
    const storedMessageCount = MAX_CLI_SESSION_HISTORY_MESSAGES + 50;

    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath },
      [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        ...Array.from({ length: storedMessageCount }, (_unused, index) => ({
          type: "message" as const,
          id: `store-${index}`,
          parentId: index > 0 ? `store-${index - 1}` : null,
          timestamp: new Date(index + 1).toISOString(),
          message: { role: "user", content: `history-${index}` },
        })),
      ],
    );

    try {
      await withCliSessionState(stateDir, async () => {
        // Context-engine projection applies no message cap of its own, so it
        // observes exactly the rows the store read returned.
        const messages = await loadCliSessionContextEngineMessages({
          sessionId,
          sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`),
          sessionKey: "agent:main:main",
          agentId: "main",
          config: { session: { store: storePath } } as OpenClawConfig,
        });
        expect(messages).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
        expectMessageFields(messages[0], {
          role: "user",
          content: `history-${storedMessageCount - MAX_CLI_SESSION_HISTORY_MESSAGES}`,
        });
        expectMessageFields(messages.at(-1), {
          role: "user",
          content: `history-${storedMessageCount - 1}`,
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips transcript-store tails when branch controls sit above the bound", async () => {
    // The file loader may project a flat transcript because it reads the whole
    // file, so its branch controls are always in hand. The store read returns a
    // bounded tail: if the leaf marker sits above the cut, a flat projection
    // would feed abandoned branches into the reseed prompt.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-severed-branch";
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const fillerCount = MAX_CLI_SESSION_HISTORY_MESSAGES + 50;

    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath },
      [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "root" },
        },
        // The only branch control, deliberately old enough to fall above the tail.
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(2).toISOString(),
          targetId: "root",
        },
        ...Array.from({ length: fillerCount }, (_unused, index) => ({
          type: "message" as const,
          id: `filler-${index}`,
          parentId: index > 0 ? `filler-${index - 1}` : "root",
          timestamp: new Date(index + 3).toISOString(),
          message: { role: "user" as const, content: `filler-${index}` },
        })),
      ],
    );

    try {
      await withCliSessionState(stateDir, async () => {
        const messages = await loadCliSessionContextEngineMessages({
          sessionId,
          sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`),
          sessionKey: "agent:main:main",
          agentId: "main",
          config: { session: { store: storePath } } as OpenClawConfig,
        });
        expect(messages).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("omits its branch controls"));
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("raw-reseeds consecutive ambient user rows", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-consecutive-ambient",
      messages: ["#10 Sam: first ambient", "#11 Lee: second ambient", "#12 Pat: @bot what now?"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-consecutive-ambient",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "missing-transcript",
        });

        expect(reseed).toHaveLength(3);
        expectMessageFields(reseed[0], { role: "user", content: "#10 Sam: first ambient" });
        expectMessageFields(reseed[1], { role: "user", content: "#11 Lee: second ambient" });
        expectMessageFields(reseed[2], { role: "user", content: "#12 Pat: @bot what now?" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not raw-reseed auth-boundary invalidations even when opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-auth-boundary",
      messages: ["previous account context"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        // Auth changes are a hard boundary: old raw messages may belong to a
        // different credential context and must not reseed a fresh CLI session.
        await expect(
          loadCliSessionReseedMessages({
            sessionId: "session-auth-boundary",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
            allowRawTranscriptReseed: true,
            rawTranscriptReseedReason: "auth-profile",
          }),
        ).resolves.toStrictEqual([]);
        await expect(
          loadCliSessionReseedMessages({
            sessionId: "session-auth-boundary",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
            allowRawTranscriptReseed: true,
            rawTranscriptReseedReason: "auth-epoch",
          }),
        ).resolves.toStrictEqual([]);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds fresh CLI sessions from the latest compaction summary and post-compaction tail", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-compacted",
      messages: ["pre-compaction raw history"],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compaction-1",
        parentId: "msg-0",
        timestamp: new Date(2).toISOString(),
        summary: "safe compacted summary",
        firstKeptEntryId: "msg-0",
        tokensBefore: 10_000,
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: "compaction-1",
        timestamp: new Date(3).toISOString(),
        message: {
          role: "user",
          content: "post-compaction ask",
          timestamp: 3,
        },
      })}\n`,
      "utf-8",
    );

    try {
      await withCliSessionState(stateDir, async () => {
        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-compacted",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expectCompactionSummary(reseed[0], "safe compacted summary");
        expectMessageFields(reseed[1], { role: "user", content: "post-compaction ask" });
        expect(reseed.map((message) => requireRecord(message, "reseed message").timestamp)).toEqual(
          ["1970-01-01T00:00:00.002Z", "1970-01-01T00:00:00.003Z"],
        );
        const prompt = buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" });
        expect(prompt).toContain(
          "[1970-01-01T00:00:00.002Z] Compaction summary: safe compacted summary",
        );
        expect(prompt).toContain("[1970-01-01T00:00:00.003Z] User: post-compaction ask");
        expect(prompt).toContain(RESEED_CURRENCY_GUIDANCE);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
