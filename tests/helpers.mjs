import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway temp dir for Cortext SQLite stores, cleaned up by the caller. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cortext-pi-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const silentLog = () => {};

/**
 * A fake pi ExtensionAPI that mirrors the REAL installed surface this
 * extension uses: exactly the eight `pi.on` overloads from src/pi.d.ts. It
 * deliberately provides NOTHING else, so a call to an unsupported surface
 * throws in tests (the bug an over-permissive stub would hide).
 */
export const SUPPORTED_EVENTS = [
  "session_start",
  "session_shutdown",
  "message_start",
  "message_update",
  "message_end",
  "before_agent_start",
  "context",
  "session_before_compact",
];

export function fakePi() {
  const handlers = new Map();
  const api = {
    on: (event, handler) => {
      if (!SUPPORTED_EVENTS.includes(event)) throw new Error(`unsupported event: ${event}`);
      handlers.set(event, handler);
    },
  };
  return { api, handlers };
}

/** A fake ExtensionContext mirroring the members src/pi.d.ts declares. */
export function fakeCtx({ sessionId = "S", cwd = "/tmp/proj", sessionFile = undefined } = {}) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd,
    sessionManager: {
      getCwd: () => cwd,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getBranch: () => [],
      buildContextEntries: () => [],
    },
    isIdle: () => true,
    getSystemPrompt: () => "base system prompt",
  };
}

// -- message constructors (real pi shapes) -----------------------------------
// Named fields (LOCAL-ARG-001): every helper that takes more than one
// argument or a boolean takes a single options object.

export const u = ({ content, ts = 1 }) => ({ role: "user", content, timestamp: ts });
export const at = ({ text, ts = 2 }) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts });
export const aCall = ({ name, args, ts = 2 }) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name, arguments: args }],
  timestamp: ts,
});
export const aBoth = ({ text, name, args, ts = 2 }) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "toolCall", id: "call_1", name, arguments: args },
  ],
  timestamp: ts,
});
export const tr = ({ text, toolName = "bash", ts = 3 }) => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: ts,
});

/** A branch entry (message) for compaction cut tests. Ids are unique across
 *  the process but tests must capture them (never hardcode "e1"-style
 *  values) — the sequence continues across tests in the same file. */
let entrySeq = 0;
export function msgEntry(message) {
  entrySeq += 1;
  return { type: "message", id: `e${entrySeq}`, parentId: null, timestamp: "t", message };
}
export function compactionEntry({ id, firstKeptEntryId }) {
  entrySeq += 1;
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "t",
    summary: "previous summary",
    firstKeptEntryId,
    tokensBefore: 10,
  };
}
