import { test } from "node:test";
import assert from "node:assert/strict";
import { InterruptGate } from "../dist/stream.js";
import { InterruptBus } from "../dist/store.js";
import { silentLog, at, u } from "./helpers.mjs";

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

test("text deltas are segmented and an interrupt stages recall on the bus (by scope key)", () => {
  const bus = new InterruptBus();
  const gate = new InterruptGate(interruptStore(), bus, silentLog, true, 12, scope);
  const msg = at("answer");
  gate.onMessageStart(msg);
  // >120 chars total, flushed at the sentence break
  for (const d of ["The deployment rollback ", "procedure is documented ", "in the runbook. "]) {
    gate.onMessageUpdate(msg, text(d));
  }
  assert.match(bus.take("s-test"), /remembered fact from the store/, "staged memory carries the recall");
  assert.equal(bus.take("other-scope"), "", "staging is keyed by scope, not session");
});

test("thinking deltas are gated by ingestReasoning", () => {
  const bus = new InterruptBus();
  const gateOff = new InterruptGate(interruptStore(), bus, silentLog, false, 12, scope);
  const msg = at("answer");
  gateOff.onMessageStart(msg);
  gateOff.onMessageUpdate(msg, thinking("reasoning that should be ignored because it is "));
  gateOff.onMessageUpdate(msg, thinking("ingestReasoning=false.\n"));
  assert.equal(bus.take("s-test"), "", "thinking must not gate when disabled");
});

test("a new assistant message resets the buffers (identity-keyed)", () => {
  const bus = new InterruptBus();
  const gate = new InterruptGate(interruptStore(), bus, silentLog, true, 12, scope);
  const m1 = at("first");
  const m2 = at("second");
  gate.onMessageStart(m1);
  gate.onMessageUpdate(m1, text("partial first message content that never finished, no break, "));
  // a different message object arrives without message_start (defensive path)
  gate.onMessageUpdate(m2, text("fresh start here.\n"));
  assert.doesNotThrow(() => {
    gate.onMessageEnd(m2);
    gate.onMessageEnd(m1); // stale end is a no-op
  });
  assert.equal(bus.take("s-test").includes("partial first"), false, "no cross-message buffer leakage");
});

test("non-delta stream events and non-assistant messages are ignored safely", () => {
  const bus = new InterruptBus();
  const gate = new InterruptGate(interruptStore(), bus, silentLog, true, 12, scope);
  assert.doesNotThrow(() => {
    gate.onMessageUpdate(at("x"), { type: "start" });
    gate.onMessageUpdate(at("x"), { type: "toolcall_delta", contentIndex: 0, delta: "{}" });
    gate.onMessageUpdate(at("x"), { type: "done" });
    gate.onMessageStart(u("user message")); // not assistant — ignored
    gate.onMessageUpdate(u("user message"), text("nope")); // user — ignored
  });
  assert.equal(bus.take("s-test"), "");
});

test("gate errors never throw out of the handler (log prefix stays distinct)", () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const badStore = { scopeKey: () => { throw new Error("boom"); }, forScope: () => {} };
  const gate = new InterruptGate(badStore, new InterruptBus(), log, true, 12, scope);
  const msg = at("answer");
  gate.onMessageStart(msg);
  assert.doesNotThrow(() => gate.onMessageUpdate(msg, text("a segment long enough to trigger a recall call that will surface an error from the fake store, and it must be logged rather than thrown outward.")));
  assert.ok(logs.some((l) => l.startsWith("cortext gate error:")), "error logged with the distinct prefix");
  assert.ok(!logs.some((l) => l.startsWith("cortext interrupt gate:")), "no fire log for a crashed handler");
});
