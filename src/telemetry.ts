import * as api from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

/**
 * OpenTelemetry diagnostics for the Cortext loop. SPANS ONLY — no metric
 * instruments (metrics are where unbounded cardinality sneaks in; spans keep
 * it structurally bounded).
 *
 * Cardinality rules (CORE-OBS-002):
 *   - span attributes are enum or numeric ONLY — NEVER scope ids, session
 *     ids, memory text, or any other free-form string (a free-form attribute
 *     on a hot path is a unique-value bomb);
 *   - the span name space is the fixed set in SPANS below;
 *   - failure paths open short-lived `outcome: "error"` spans with the same
 *     names — we deliberately do NOT record exception objects (an exception
 *     event carries the message, which is free-form text).
 *
 * Offline by construction: with no SDK registered, the @opentelemetry/api
 * singleton hands back non-recording no-op proxies — zero network, zero
 * exporters, nothing leaves the process. Diagnostics must never change
 * functional behavior: every helper is throw-proof (a broken provider must
 * not take down a memory handler), and spans never block a handler.
 *
 * Span catalog (attrs in parentheses; all enums or numbers):
 *   cortext.ingest        (role, outcome, textLength)
 *   cortext.recall        (surface, outcome, memoryCount)
 *   cortext.compact       (mode, outcome, dropped)
 *   cortext.gate          (stream, kind, stagedCount)
 *   cortext.engine.create (outcome)  — native engine open failed for a scope
 *   cortext.engine.flush  (outcome)  — engine flush failed (compact/shutdown)
 */

const TRACER_NAME = "cortext-pi-extension";
const TRACER_VERSION = "0.1.0";

const tracer = api.trace.getTracer(TRACER_NAME, TRACER_VERSION);

/** The fixed span name space (bounded — see CORE-OBS-002). */
export const SPANS = {
  /** Durable per-message ingest (message_end). */
  ingest: "cortext.ingest",
  /** Live recall (system-prompt / per-LLM-call / gate surfaces). */
  recall: "cortext.recall",
  /** Extension-provided zero-LLM compaction. */
  compact: "cortext.compact",
  /** Streaming gate fire (interrupt / boundary). */
  gate: "cortext.gate",
  /** Native engine creation failure (store scope open). */
  engineCreate: "cortext.engine.create",
  /** Engine flush failure (compaction / shutdown checkpoint). */
  engineFlush: "cortext.engine.flush",
} as const;

export type SpanName = (typeof SPANS)[keyof typeof SPANS];

/** Enum values for the `outcome` attribute. */
export const OUTCOME = {
  ok: "ok",
  error: "error",
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/** Enum values for the recall `surface` attribute. */
export const SURFACES = {
  systemPrompt: "system-prompt",
  context: "context",
  gate: "gate",
} as const;

export type Surface = (typeof SURFACES)[keyof typeof SURFACES];

/** Enum-or-numeric attributes only (CORE-OBS-002). */
export type SpanAttributes = Record<string, string | number | boolean>;

/** Minimal non-recording fallback: a broken provider must degrade to
 *  silence, never throw out of a handler. */
const NOOP_SPAN: Span = {
  spanContext: () => ({
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
    traceFlags: 0,
  }),
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  addLink: () => NOOP_SPAN,
  addLinks: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  updateName: () => NOOP_SPAN,
  end: () => { /* no-op */ },
  isRecording: () => false,
  recordException: () => { /* no-op */ },
};

/** Open a span (non-recording no-op proxy when no SDK is installed). */
export function startSpan(options: { name: SpanName; attributes?: SpanAttributes }): Span {
  try {
    return tracer.startSpan(options.name, { attributes: options.attributes });
  } catch {
    return NOOP_SPAN;
  }
}

/** Merge final attributes (incl. outcome), then end the span. */
export function endSpan(options: { span: Span; outcome?: Outcome; attributes?: SpanAttributes }): void {
  const { span, outcome, attributes } = options;
  try {
    const merged: SpanAttributes = { ...attributes };
    if (outcome !== undefined) merged.outcome = outcome;
    if (Object.keys(merged).length > 0) span.setAttributes(merged);
    span.end();
  } catch { /* diagnostics must never change functional behavior */ }
}

/** One-shot failure span for the existing catch blocks (outcome=error, no
 *  exception text — see CORE-OBS-002). */
export function recordFailure(options: { name: SpanName; attributes?: SpanAttributes }): void {
  const span = startSpan({ name: options.name, attributes: { outcome: OUTCOME.error, ...options.attributes } });
  span.end();
}
