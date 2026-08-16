import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOME, SPANS, SURFACES, endSpan, recordFailure, startSpan } from "../dist/telemetry.js";

// C3: with NO OpenTelemetry SDK installed (the extension's only supported
// runtime state — it must stay fully offline), the API hands back non-
// recording no-op proxies. Importing and opening/closing spans must never
// throw, and diagnostics must be invisible to functional behavior.

test("telemetry: import + open/close spans works with no SDK installed (no throw)", () => {
  const span = startSpan({ name: SPANS.ingest, attributes: { role: "user", textLength: 12 } });
  assert.equal(typeof span.end, "function", "span proxy is usable");
  assert.equal(span.isRecording(), false, "no provider registered -> non-recording span");
  assert.doesNotThrow(() => endSpan({ span, outcome: OUTCOME.ok }));
  // Double-ending must stay safe: a handler calling endSpan twice must not
  // change functional behavior.
  assert.doesNotThrow(() => span.end());
});

test("telemetry: every operation span opens and closes without an SDK", () => {
  const spans = [
    startSpan({ name: SPANS.ingest, attributes: { role: "assistant", textLength: 3, outcome: OUTCOME.ok } }),
    startSpan({ name: SPANS.recall, attributes: { surface: SURFACES.systemPrompt, memoryCount: 4 } }),
    startSpan({ name: SPANS.recall, attributes: { surface: SURFACES.context } }),
    startSpan({ name: SPANS.recall, attributes: { surface: SURFACES.gate } }),
    startSpan({ name: SPANS.compact, attributes: { mode: "hybrid", dropped: 8 } }),
    startSpan({ name: SPANS.gate, attributes: { stream: "thinking", kind: "interrupt", stagedCount: 2 } }),
  ];
  assert.doesNotThrow(() => {
    for (const s of spans) endSpan({ s, outcome: OUTCOME.ok });
    recordFailure({ name: SPANS.engineCreate });
    recordFailure({ name: SPANS.engineFlush });
    recordFailure({ name: SPANS.recall, attributes: { surface: SURFACES.gate } });
  });
});

test("telemetry: span name space is the fixed bounded set (CORE-OBS-002)", () => {
  assert.equal(SPANS.ingest, "cortext.ingest");
  assert.equal(SPANS.recall, "cortext.recall");
  assert.equal(SPANS.compact, "cortext.compact");
  assert.equal(SPANS.gate, "cortext.gate");
  assert.equal(SPANS.engineCreate, "cortext.engine.create");
  assert.equal(SPANS.engineFlush, "cortext.engine.flush");
});

test("telemetry: enum constants match the documented attribute values", () => {
  assert.deepEqual(OUTCOME, { ok: "ok", error: "error" });
  assert.deepEqual(SURFACES, { systemPrompt: "system-prompt", context: "context", gate: "gate" });
});
