import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
// Covers the byte ceiling the SQLite transcript-store reader shares with the
// legacy JSONL loader, and the branch-control guard under byte trimming.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MAX_CLI_SESSION_HISTORY_BYTES } from "../../shared/session-transcript-limits.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cliBackendLog } from "./log.js";
import { loadCliSessionContextEngineMessages } from "./session-history.js";

const requireRecord = createRequireRecord("object", "expected-label");

function expectMessageFields(value: unknown, expected: { role: string; content?: unknown }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toEqual(expected.content);
  }
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

describe("loadCliSessionEntriesFromStore byte bound", () => {
  it("keeps the newest transcript-store events that fit the history byte budget", async () => {
    // The row cap is not a memory bound: a single persisted event carries
    // arbitrary bytes, so 100 rows can decode to far more than the 5 MiB the
    // file loader would ever read. The byte budget is the equivalent ceiling.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-byte-bound";
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    // Two of these exceed the budget together; one fits with room to spare.
    const bulkContent = "x".repeat(Math.floor(MAX_CLI_SESSION_HISTORY_BYTES * 0.6));

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
          id: "bulk-oldest",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: `oldest-${bulkContent}` },
        },
        {
          type: "message",
          id: "bulk-newer",
          parentId: "bulk-oldest",
          timestamp: new Date(2).toISOString(),
          message: { role: "user", content: `newer-${bulkContent}` },
        },
        {
          type: "message",
          id: "tail",
          parentId: "bulk-newer",
          timestamp: new Date(3).toISOString(),
          message: { role: "user", content: "newest tail" },
        },
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
        // Every row is inside the 100-row cap, so only the byte budget can trim
        // this window — and it keeps the newest events, like the file loader.
        expect(messages).toHaveLength(2);
        expectMessageFields(messages[0], { role: "user", content: `newer-${bulkContent}` });
        expectMessageFields(messages.at(-1), { role: "user", content: "newest tail" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `transcript-store tail truncated to last ${MAX_CLI_SESSION_HISTORY_BYTES} bytes`,
          ),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips a transcript-store event larger than the whole history byte budget", async () => {
    // The file loader can keep a partial byte window; a JSON value cannot be
    // partially decoded. An event that alone exceeds the budget is therefore
    // dropped without ever being selected for parsing, rather than being
    // allowed to stall this synchronous read.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-oversized-event";
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const oversizedContent = "x".repeat(MAX_CLI_SESSION_HISTORY_BYTES + 1024);

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
          id: "before-oversized",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "before oversized" },
        },
        {
          type: "message",
          id: "oversized",
          parentId: "before-oversized",
          timestamp: new Date(2).toISOString(),
          message: { role: "user", content: oversizedContent },
        },
        {
          type: "message",
          id: "after-oversized",
          parentId: "oversized",
          timestamp: new Date(3).toISOString(),
          message: { role: "user", content: "after oversized" },
        },
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
        // The neighbours survive: one unreadably large event must not cost the
        // whole reseed window.
        expect(messages).toHaveLength(2);
        expectMessageFields(messages[0], { role: "user", content: "before oversized" });
        expectMessageFields(messages.at(-1), { role: "user", content: "after oversized" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `transcript-store skipped 1 transcript event(s) larger than ${MAX_CLI_SESSION_HISTORY_BYTES} bytes`,
          ),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips transcript-store tails whose branch controls are cut off by the byte budget", async () => {
    // The severed-branch guard has to answer about the window the reader kept,
    // not about the row cap. Every row here fits the 100-row cap, so only the
    // byte budget moves the cut — and it moves it past the only leaf control.
    // A guard that still probed the row cutoff would call this window complete
    // and project abandoned branches flat.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "session-store-byte-severed-branch";
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const bulkContent = "x".repeat(Math.floor(MAX_CLI_SESSION_HISTORY_BYTES * 0.6));

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
        // The only branch control, small enough to sit well inside the row cap.
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(2).toISOString(),
          targetId: "root",
        },
        {
          type: "message",
          id: "bulk-older",
          parentId: "root",
          timestamp: new Date(3).toISOString(),
          message: { role: "user", content: `older-${bulkContent}` },
        },
        {
          type: "message",
          id: "bulk-newer",
          parentId: "bulk-older",
          timestamp: new Date(4).toISOString(),
          message: { role: "user", content: `newer-${bulkContent}` },
        },
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
});
