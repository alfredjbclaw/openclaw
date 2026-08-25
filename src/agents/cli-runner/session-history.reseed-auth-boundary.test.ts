/**
 * Whether a cleared CLI binding that recorded no auth identity may still replay
 * its prior transcript into a fresh CLI session.
 *
 * Lives beside `session-history.test.ts` because it asserts the whole chain —
 * reuse resolution, prepare's reason default, the raw-reseed allowlist — rather
 * than one loader behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  clearCliSession,
  cliSessionClearAuthFromRun,
  getCliSessionBinding,
  resolveCliSessionReuse,
  setCliSessionId,
} from "../cli-session.js";
import { buildCliSessionHistoryPrompt, loadCliSessionReseedMessages } from "./session-history.js";

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  messages: string[];
}): string {
  // Same canonical JSONL envelope order the sibling suite writes, so the loader
  // exercises the shape persisted OpenClaw sessions actually have.
  const sessionFile = path.join(
    params.rootDir,
    "agents",
    "main",
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
  for (const [index, message] of params.messages.entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: { role: "user", content: message, timestamp: index + 1 },
      })}\n`,
      "utf-8",
    );
  }
  return sessionFile;
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

/** `prepare.ts`'s reason for a turn with no reusable CLI session id. */
function reseedReasonForNextTurn(
  entry: SessionEntry,
  current: { authProfileId?: string; authEpoch?: string; authEpochVersion: number },
) {
  const reuse = resolveCliSessionReuse({
    binding: getCliSessionBinding(entry, "claude-cli"),
    ...current,
  });
  expect(reuse.mode).not.toBe("reuse");
  const invalidatedReason = reuse.mode === "invalidate" ? reuse.invalidatedReason : undefined;
  return invalidatedReason ?? "missing-transcript";
}

describe("raw reseed across a cleared binding that recorded no auth identity", () => {
  // End-to-end shape of the P1: a bare binding (the `setCliSessionId` fallback,
  // and the legacy rows it stands in for) is cleared, and the next turn decides
  // whether the prior transcript may replay into the fresh CLI session. The
  // decision runs through the real chain — reuse resolution, prepare's reason
  // default, then the reseed allowlist — rather than asserting any one step.
  const CURRENT_IDENTITY = {
    authProfileId: "anthropic:current",
    authEpoch: "epoch-current",
    authEpochVersion: 1,
  } as const;

  async function reseedAfterClear(current: {
    authProfileId?: string;
    authEpoch?: string;
    authEpochVersion: number;
  }): Promise<unknown[]> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-cleared-bare-binding",
      messages: ["prior-auth secret"],
    });
    const entry = { sessionId: "session-cleared-bare-binding" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");
    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(CURRENT_IDENTITY));

    try {
      return await withCliSessionState(stateDir, async () =>
        loadCliSessionReseedMessages({
          sessionId: "session-cleared-bare-binding",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          // The claude-cli backend opts in (`reseedFromRawTranscriptWhenUncompacted`).
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: reseedReasonForNextTurn(entry, current),
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it("replays the prior transcript when the next turn carries the same auth identity", async () => {
    const reseed = await reseedAfterClear(CURRENT_IDENTITY);
    expect(reseed.length).toBeGreaterThan(0);
    expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
      "prior-auth secret",
    );
  });

  it("refuses the replay when the next turn carries a different auth identity", async () => {
    const reseed = await reseedAfterClear({
      authProfileId: "anthropic:rotated",
      authEpoch: "epoch-rotated",
      authEpochVersion: 1,
    });
    expect(reseed).toStrictEqual([]);
  });
});

describe("compacted transcripts across an auth boundary", () => {
  // The compacted branch used to return the compaction summary plus the
  // verbatim post-compaction tail without consulting the reseed reason at all,
  // so an auth crossing that the raw path refused still replayed prior-auth
  // content by that route. A summary is transcript-derived too — it is written
  // *from* the turns the previous identity ran — so the boundary refuses both.
  const PRIOR_IDENTITY = {
    authProfileId: "anthropic:prior",
    authEpoch: "epoch-prior",
    authEpochVersion: 1,
  } as const;
  const SESSION_ID = "session-compacted-auth-boundary";

  function createCompactedTranscript(rootDir: string): string {
    const sessionFile = createSessionTranscript({
      rootDir,
      sessionId: SESSION_ID,
      messages: ["prior-auth secret"],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compact-1",
        timestamp: new Date(2).toISOString(),
        summary: "Summary derived from the prior-auth conversation",
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "msg-tail",
        parentId: "compact-1",
        timestamp: new Date(3).toISOString(),
        message: { role: "user", content: "post-compaction tail secret", timestamp: 3 },
      })}\n`,
      "utf-8",
    );
    return sessionFile;
  }

  /** Reseed the compacted transcript for a turn whose identity is `current`. */
  async function reseedCompactedAfterClear(current: {
    authProfileId?: string;
    authEpoch?: string;
    authEpochVersion: number;
  }): Promise<{ reason: string; messages: unknown[] }> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createCompactedTranscript(stateDir);
    const entry = { sessionId: SESSION_ID } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare", PRIOR_IDENTITY);
    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(PRIOR_IDENTITY));
    const reason = reseedReasonForNextTurn(entry, current);

    try {
      return {
        reason,
        messages: await withCliSessionState(stateDir, async () =>
          loadCliSessionReseedMessages({
            sessionId: SESSION_ID,
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
            allowRawTranscriptReseed: true,
            rawTranscriptReseedReason: reason,
          }),
        ),
      };
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it("reseeds the summary and the post-compaction tail when no auth boundary is crossed", async () => {
    // The control: without this the refusal tests below could pass vacuously,
    // for want of any compacted content to refuse in the first place.
    const { reason, messages } = await reseedCompactedAfterClear(PRIOR_IDENTITY);
    expect(reason).toBe("missing-transcript");
    const prompt = buildCliSessionHistoryPrompt({ messages, prompt: "next" });
    expect(prompt).toContain("Summary derived from the prior-auth conversation");
    expect(prompt).toContain("post-compaction tail secret");
  });

  it("returns no compacted content when the auth profile changed", async () => {
    const { reason, messages } = await reseedCompactedAfterClear({
      authProfileId: "anthropic:rotated",
      authEpoch: "epoch-rotated",
      authEpochVersion: 1,
    });
    expect(reason).toBe("auth-profile");
    expect(messages).toStrictEqual([]);
  });

  it("returns no compacted content when the auth epoch changed", async () => {
    const { reason, messages } = await reseedCompactedAfterClear({
      // Same profile, rotated credential under the same epoch version: the
      // crossing reuse resolution reports as `auth-epoch` rather than `auth-profile`.
      authProfileId: PRIOR_IDENTITY.authProfileId,
      authEpoch: "epoch-rotated",
      authEpochVersion: PRIOR_IDENTITY.authEpochVersion,
    });
    expect(reason).toBe("auth-epoch");
    expect(messages).toStrictEqual([]);
  });
});
