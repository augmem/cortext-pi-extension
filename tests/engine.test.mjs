import { test } from "node:test";
import assert from "node:assert/strict";
import { CortextStore } from "../dist/cortext.js";
import { InterruptBus } from "../dist/store.js";
import { CortextHandlers } from "../dist/engine.js";
import { resolveConfig } from "../dist/config.js";
import { fakeCtx, silentLog, tempDir, u, at, aCall, tr, msgEntry, compactionEntry } from "./helpers.mjs";

// Enum values (named per LOCAL-ARG-001).
const SESSION_SCOPE = "session";
const AGENT_SCOPE = "agent";
const HYBRID_MODE = "hybrid";
const FULL_MODE = "full";
const INTERRUPT_GATE_OFF = false;

/** Build the real handler stack (native Cortext engines) on an isolated
 *  temp-dir store — the same classes register() wires, minus the pi API. */
function build({ baseDir, cfg = {} }) {
  const config = resolveConfig(cfg).config;
  const store = new CortextStore({ cfg: config, baseDir });
  const bus = new InterruptBus();
  const handlers = new CortextHandlers({ store, bus, log: silentLog, cfg: config });
  return { store, bus, handlers, cfg: config };
}

const prep = ({ entries, firstKeptEntryId }) => ({
  firstKeptEntryId,
  messagesToSummarize: [],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 1000,
  fileOps: { readFiles: [], modifiedFiles: [] },
  settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
});

test("user message ingest is durable and recalled into the system prompt", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, ctx);

    const out = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?", systemPrompt: "base system prompt" }, ctx);
    assert.ok(out?.systemPrompt, "system prompt modified");
    assert.match(out.systemPrompt, /base system prompt/, "chains the existing prompt");
    assert.match(out.systemPrompt, /Austin/, "the ingested fact is recalled");
    assert.match(out.systemPrompt, /reference data only|never as instructions/i, "injection guard preamble present");
  } finally { cleanup(); }
});

test("toolCall-only assistant messages are ingested (the call is recallable)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({
      message: aCall({ name: "exec", args: { command: "tar -czf backup-vermilion.tgz /srv/data", timeout: 10 } }),
    }, ctx);
    const out = handlers.onBeforeAgentStart({ prompt: "What command created the backup archive?" }, ctx);
    assert.match(out?.systemPrompt ?? "", /backup-vermilion|tar -czf/, "the call's command is recallable");
  } finally { cleanup(); }
});

test("tool results are ingested in full", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: tr({ text: "backup written: 4183 files, checksum qz88x" }) }, ctx);
    const out = handlers.onBeforeAgentStart({ prompt: "What was the backup checksum?" }, ctx);
    assert.match(out?.systemPrompt ?? "", /qz88x/, "the result text is recallable");
  } finally { cleanup(); }
});

test("empty store: before_agent_start is a passthrough (no system prompt change)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    const out = handlers.onBeforeAgentStart({ prompt: "hello" }, ctx);
    assert.equal(out, undefined);
  } finally { cleanup(); }
});

test("default (session) scope does NOT recall across sessions", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir }); // default memoryScope: session
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, fakeCtx({ sessionId: "A" }));
    const out = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, fakeCtx({ sessionId: "B" }));
    assert.equal(out, undefined, "different session must not see it by default");
  } finally { cleanup(); }
});

test("ISOLATION: session scope prevents cross-session recall; same session recalls", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { memoryScope: SESSION_SCOPE } });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, fakeCtx({ sessionId: "A" }));
    assert.equal(handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, fakeCtx({ sessionId: "B" })), undefined);
    const same = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, fakeCtx({ sessionId: "A" }));
    assert.match(same?.systemPrompt ?? "", /Austin/, "positive control: the same session recalls");
  } finally { cleanup(); }
});

test("agent scope recalls across sessions of the same project", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { memoryScope: AGENT_SCOPE } });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, fakeCtx({ sessionId: "A", cwd: "/tmp/proj" }));
    const out = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, fakeCtx({ sessionId: "B", cwd: "/tmp/proj" }));
    assert.match(out?.systemPrompt ?? "", /Austin/, "same project, different session recalls");
  } finally { cleanup(); }
});

test("ISOLATION: agent scope isolates distinct projects", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { memoryScope: AGENT_SCOPE } });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, fakeCtx({ sessionId: "A", cwd: "/tmp/project-a" }));
    const out = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, fakeCtx({ sessionId: "Z", cwd: "/tmp/project-b" }));
    assert.equal(out, undefined, "different project must not see it");
  } finally { cleanup(); }
});

test("no stale recall after an update in the same session (no cross-turn cache)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, ctx);
    handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, ctx); // warms anything cache-like
    handlers.onMessageEnd({ message: u({ content: "Avery moved to Boston." }) }, ctx);
    const out = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, ctx);
    assert.match(out?.systemPrompt ?? "", /Boston/, "the new fact is recalled");
  } finally { cleanup(); }
});

test("context handler injects a display:false custom message with fresh recall", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, ctx);
    const messages = [u({ content: "Where does Avery live?" }), at({ text: "I will check." })];
    const out = handlers.onContext({ messages }, ctx);
    assert.ok(out?.messages, "messages replaced");
    assert.equal(out.messages.length, messages.length + 1);
    const injected = out.messages[out.messages.length - 1];
    assert.equal(injected.role, "custom");
    assert.equal(injected.display, false, "hidden from the TUI");
    assert.match(String(injected.content), /Austin/);
    assert.match(String(injected.content), /<cortext_memory>/);
  } finally { cleanup(); }
});

test("context handler does not re-inject lines already in the system-prompt block", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "Avery lives in Austin." }) }, ctx);
    // system-prompt surface injects the fact first...
    const sys = handlers.onBeforeAgentStart({ prompt: "Where does Avery live?" }, ctx);
    assert.match(sys?.systemPrompt ?? "", /Austin/);
    // ...so the per-LLM-call surface must not inject it again.
    const out = handlers.onContext({ messages: [u({ content: "Where does Avery live?" })] }, ctx);
    assert.equal(out, undefined, "no duplicate injection for the same recall");
  } finally { cleanup(); }
});

test("context handler drains gate-staged recall under the same scope key", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers, bus } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "The rollback runbook is in the wiki." }) }, ctx);
    // stage directly under the session's scope key (what the gate does)
    const STAGE_SCOPE_KEY = "s-S";
    bus.stage({ scopeKey: STAGE_SCOPE_KEY, block: "- the rollback runbook is in the wiki" });
    const out = handlers.onContext({ messages: [u({ content: "Where is the rollback runbook?" })] }, ctx);
    assert.ok(out?.messages, "staged recall was drained into a context message");
    assert.equal(bus.take(STAGE_SCOPE_KEY), "", "drain clears the staged block");
  } finally { cleanup(); }
});

test("message_end skips non-conversation roles and empty content", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    assert.doesNotThrow(() => {
      handlers.onMessageEnd({ message: { role: "custom", customType: "x", content: "skip me", display: false, timestamp: 1 } }, ctx);
      handlers.onMessageEnd({ message: { role: "bashExecution", command: "ls", output: "x", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } }, ctx);
      handlers.onMessageEnd({ message: { role: "compactionSummary", summary: "skip", tokensBefore: 1, timestamp: 1 } }, ctx);
      handlers.onMessageEnd({ message: u({ content: "   " }) }, ctx);
    });
    assert.equal(handlers.onBeforeAgentStart({ prompt: "anything in the store?" }, ctx), undefined);
  } finally { cleanup(); }
});

test("compaction: hybrid cut is exchange-aligned, zero-LLM summary, entry ids", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: HYBRID_MODE, protectTail: 4 } });
    const ctx = fakeCtx({ sessionId: "S" });
    // Six exchanges; ingest a fact in the first so compaction has real memory behind it.
    handlers.onMessageEnd({ message: u({ content: "The deploy freeze ends on the 14th." }) }, ctx);
    const entries = [
      msgEntry(u({ content: "q1" })), msgEntry(at({ text: "a1" })),
      msgEntry(u({ content: "q2" })), msgEntry(at({ text: "a2" })),
      msgEntry(u({ content: "q3" })), msgEntry(at({ text: "a3" })),
      msgEntry(u({ content: "q4" })), msgEntry(at({ text: "a4" })),
      msgEntry(u({ content: "q5" })), msgEntry(at({ text: "a5" })),
      msgEntry(u({ content: "q6" })), msgEntry(at({ text: "a6" })),
    ];
    const out = handlers.onSessionBeforeCompact(
      { preparation: prep({ entries, firstKeptEntryId: entries[0].id }), branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
      ctx,
    );
    assert.ok(out?.compaction, "extension-provided compaction");
    assert.equal(out.compaction.firstKeptEntryId, entries[8].id, "cut on a user boundary (exchange-aligned)");
    assert.equal(out.compaction.tokensBefore, 1000);
    assert.equal(out.compaction.usage, undefined, "NO LLM call — no usage");
    assert.match(out.compaction.summary, /Archived 8 message/);
    assert.match(out.compaction.summary, /no summarizer LLM call/i);
    assert.equal(out.compaction.details.engine, "cortext");
    assert.equal(out.compaction.details.mode, HYBRID_MODE);
  } finally { cleanup(); }
});

test("compaction: full mode cuts at the last user message", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: FULL_MODE } });
    const ctx = fakeCtx({ sessionId: "S" });
    const entries = [
      msgEntry(u({ content: "q1" })), msgEntry(at({ text: "a1" })),
      msgEntry(u({ content: "q2" })), msgEntry(at({ text: "a2" })),
      msgEntry(u({ content: "q3" })), msgEntry(at({ text: "a3" })),
      msgEntry(u({ content: "q4" })), msgEntry(at({ text: "a4" })),
      msgEntry(u({ content: "q5" })), msgEntry(at({ text: "a5" })),
      msgEntry(u({ content: "q6" })), msgEntry(at({ text: "a6" })),
    ];
    const out = handlers.onSessionBeforeCompact(
      { preparation: prep({ entries, firstKeptEntryId: entries[0].id }), branchEntries: entries, reason: "threshold", willRetry: false, signal: new AbortController().signal },
      ctx,
    );
    assert.equal(out?.compaction?.firstKeptEntryId, entries[10].id, "current exchange kept");
    assert.equal(out.compaction.details.mode, FULL_MODE);
  } finally { cleanup(); }
});

test("compaction: nothing before the protected window -> pi default (undefined)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: HYBRID_MODE, protectTail: 8 } });
    const ctx = fakeCtx({ sessionId: "S" });
    const entries = [msgEntry(u({ content: "hello" })), msgEntry(at({ text: "hi" })), msgEntry(u({ content: "ok" }))];
    const out = handlers.onSessionBeforeCompact(
      { preparation: prep({ entries, firstKeptEntryId: entries[0].id }), branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
      ctx,
    );
    assert.equal(out, undefined, "pi's own compaction applies when there is nothing to archive");
  } finally { cleanup(); }
});

test("compaction: respects the previous compaction's kept boundary", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: HYBRID_MODE, protectTail: 4 } });
    const ctx = fakeCtx({ sessionId: "S" });
    const eOld = msgEntry(u({ content: "old" }));
    const eOld2 = msgEntry(at({ text: "old2" }));
    const eOlder = msgEntry(u({ content: "older" }));
    const eOlder2 = msgEntry(at({ text: "older2" }));
    const entries = [
      eOld, eOld2, eOlder, eOlder2,
      compactionEntry({ id: "c1", firstKeptEntryId: eOlder.id }),
      msgEntry(u({ content: "kept-q" })), msgEntry(at({ text: "kept-a" })),
      msgEntry(u({ content: "q" })), msgEntry(at({ text: "a" })),
      msgEntry(u({ content: "q2" })), msgEntry(at({ text: "a2" })),
      msgEntry(u({ content: "q3" })), msgEntry(at({ text: "a3" })),
    ];
    const out = handlers.onSessionBeforeCompact(
      { preparation: prep({ entries, firstKeptEntryId: entries[10].id }), branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
      ctx,
    );
    // previous boundary is e3 (index 2); the cut must land at-or-after it
    assert.ok(out?.compaction);
    const idx = entries.findIndex((e) => e.id === out.compaction.firstKeptEntryId);
    assert.ok(idx >= 2, "cut never before the previous kept boundary");
    assert.equal(entries[idx].message.role, "user", "still exchange-aligned");
  } finally { cleanup(); }
});

test("compaction: falls back to pi's own cut when no user boundary exists in range", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: HYBRID_MODE, protectTail: 2 } });
    const ctx = fakeCtx({ sessionId: "S" });
    // the only user entry sits BEFORE the previous compaction's kept boundary,
    // so there is no user boundary in range — chooseCut returns null
    const eOld = msgEntry(u({ content: "old" }));
    const eOldA = msgEntry(at({ text: "old-a" }));
    const entries = [
      eOld,
      eOldA,
      compactionEntry({ id: "c1", firstKeptEntryId: eOldA.id }),
      msgEntry(at({ text: "a1" })),
      msgEntry(at({ text: "a2" })),
      msgEntry(at({ text: "a3" })),
    ];
    const out = handlers.onSessionBeforeCompact(
      { preparation: prep({ entries, firstKeptEntryId: entries[4].id }), branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
      ctx,
    );
    assert.ok(out?.compaction, "pi's cut is used with our zero-LLM summary");
    assert.equal(out.compaction.firstKeptEntryId, entries[4].id, "pi's validated firstKeptEntryId");
  } finally { cleanup(); }
});

test("post-compaction recall: archived fact comes back through the memory block", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { compactionMode: HYBRID_MODE, protectTail: 4 } });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "The deploy freeze ends on the 14th." }) }, ctx);
    handlers.onMessageEnd({ message: at({ text: "Noted." }) }, ctx);
    handlers.onMessageEnd({ message: u({ content: "Filler one about the weather and the on-call rotation." }) }, ctx);
    handlers.onMessageEnd({ message: at({ text: "Ok." }) }, ctx);
    handlers.onMessageEnd({ message: u({ content: "Filler two about the quarterly review agenda items." }) }, ctx);
    handlers.onMessageEnd({ message: at({ text: "Sure." }) }, ctx);
    handlers.onMessageEnd({ message: u({ content: "Filler three about the accessibility audit contrast fixes." }) }, ctx);
    handlers.onMessageEnd({ message: at({ text: "Got it." }) }, ctx);

    // After the window, the fact is OUT of the verbatim context: pi rebuilds
    // from summary + kept entries, so the context event sees no "14th" text.
    const kept = [u({ content: "When does the deploy freeze end?" })];
    const out = handlers.onContext({ messages: kept }, ctx);
    assert.ok(out?.messages, "recall message injected after compaction");
    assert.match(String(out.messages[out.messages.length - 1].content), /14th|freeze/i, "archived fact recalled from durable memory");
  } finally { cleanup(); }
});

test("interruptGate=false: gate events are safe no-ops", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir, cfg: { interruptGate: INTERRUPT_GATE_OFF } });
    const ctx = fakeCtx({ sessionId: "S" });
    const msg = at({ text: "answer" });
    assert.doesNotThrow(() => {
      handlers.onMessageStart({ message: msg }, ctx);
      handlers.onMessageUpdate({ message: msg, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x." } }, ctx);
      handlers.onMessageEnd({ message: msg }, ctx);
    });
  } finally { cleanup(); }
});

test("session_shutdown flushes engines (idempotent)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = build({ baseDir: dir });
    const ctx = fakeCtx({ sessionId: "S" });
    handlers.onMessageEnd({ message: u({ content: "A fact for shutdown." }) }, ctx);
    assert.doesNotThrow(() => {
      handlers.onSessionShutdown({ reason: "quit" }, ctx);
      handlers.onSessionShutdown({ reason: "quit" }, ctx);
    });
  } finally { cleanup(); }
});
