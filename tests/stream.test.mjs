import { test } from "node:test";
import assert from "node:assert/strict";
import { InterruptGate } from "../dist/stream.js";
import { InterruptBus } from "../dist/store.js";
import { silentLog, at, u } from "./helpers.mjs";

// Named per LOCAL-ARG-001 (bare booleans / magic numbers get constants).
const INGEST_REASONING_ON = true;
const INGEST_REASONING_OFF = false;
const GATE_RECALL_LIMIT = 12;

/** A store double that always reports an interrupt, so the staging path can
 *  be exercised deterministically (the real native engine's interrupt
 *  threshold is not unit-testable). */
function interruptStore() {
  return {
    scopeKey: () => "s-test",
    forScope: () => ({
      recall: () => ({
        should_interrupt: true,
        at_boundary: false,
        retrieved_memory: [{ modality: "text", text: "remembered fact from the store" }],
        working_memory: [],
      }),
    }),
  };
}

const scope = () => "s-test";
const text = (delta) => ({ type: "text_delta", contentIndex: 0, delta });
const thinking = (delta) => ({ type: "thinking_delta", contentIndex: 0, delta });

const gate = ({ store, bus, log = silentLog, ingestReasoning = INGEST_REASONING_ON }) =>
  new InterruptGate({ store, bus, log, ingestReasoning, recallLimit: GATE_RECALL_LIMIT, scopeKeyProvider: scope });

test("text deltas are segmented and an interrupt stages recall on the bus (by scope key)", () => {
  const bus = new InterruptBus();
  const g = gate({ store: interruptStore(), bus });
  const msg = at({ text: "answer" });
  g.onMessageStart(msg);
  // >120 chars total, flushed at the sentence break
  for (const d of ["The deployment rollback ", "procedure is documented ", "in the runbook. "]) {
    g.onMessageUpdate(msg, text(d));
  }
  assert.match(bus.take("s-test"), /remembered fact from the store/, "staged memory carries the recall");
  assert.equal(bus.take("other-scope"), "", "staging is keyed by scope, not session");
});

test("thinking deltas are gated by ingestReasoning", () => {
  const bus = new InterruptBus();
  const gateOff = gate({ store: interruptStore(), bus, log: silentLog, ingestReasoning: INGEST_REASONING_OFF });
  const msg = at({ text: "answer" });
  gateOff.onMessageStart(msg);
  gateOff.onMessageUpdate(msg, thinking("reasoning that should be ignored because it is "));
  gateOff.onMessageUpdate(msg, thinking("ingestReasoning=false.\n"));
  assert.equal(bus.take("s-test"), "", "thinking must not gate when disabled");
});

test("a new assistant message resets the buffers (identity-keyed)", () => {
  const bus = new InterruptBus();
  const g = gate({ store: interruptStore(), bus });
  const m1 = at({ text: "first" });
  const m2 = at({ text: "second" });
  g.onMessageStart(m1);
  g.onMessageUpdate(m1, text("partial first message content that never finished, no break, "));
  // a different message object arrives without message_start (defensive path)
  g.onMessageUpdate(m2, text("fresh start here.\n"));
  assert.doesNotThrow(() => {
    g.onMessageEnd(m2);
    g.onMessageEnd(m1); // stale end is a no-op
  });
  assert.equal(bus.take("s-test").includes("partial first"), false, "no cross-message buffer leakage");
});

test("non-delta stream events and non-assistant messages are ignored safely", () => {
  const bus = new InterruptBus();
  const g = gate({ store: interruptStore(), bus });
  assert.doesNotThrow(() => {
    g.onMessageUpdate(at({ text: "x" }), { type: "start" });
    g.onMessageUpdate(at({ text: "x" }), { type: "toolcall_delta", contentIndex: 0, delta: "{}" });
    g.onMessageUpdate(at({ text: "x" }), { type: "done" });
    g.onMessageStart(u({ content: "user message" })); // not assistant — ignored
    g.onMessageUpdate(u({ content: "user message" }), text("nope")); // user — ignored
  });
  assert.equal(bus.take("s-test"), "");
});

test("gate errors never throw out of the handler (log prefix stays distinct)", () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const badStore = { scopeKey: () => { throw new Error("boom"); }, forScope: () => {} };
  const g = gate({ store: badStore, bus: new InterruptBus(), log });
  const msg = at({ text: "answer" });
  g.onMessageStart(msg);
  assert.doesNotThrow(() => g.onMessageUpdate(msg, text("a segment long enough to trigger a recall call that will surface an error from the fake store, and it must be logged rather than thrown outward.")));
  assert.ok(logs.some((l) => l.startsWith("cortext gate error:")), "error logged with the distinct prefix");
  assert.ok(!logs.some((l) => l.startsWith("cortext interrupt gate:")), "no fire log for a crashed handler");
});
