import type { AssistantMessageEvent, AgentMessage } from "./pi.js";
import { CortextStore, formatMemories, safe } from "./cortext.js";
import type { InterruptBus } from "./store.js";
import { OUTCOME, SPANS, SURFACES, endSpan, recordFailure, startSpan } from "./telemetry.js";

const SEGMENT_MIN_CHARS = 120;
const BREAK = /[.!?\n]/;

type GatedStream = "thinking" | "assistant";

interface StreamBuf {
  buffer: string;
}
function emptyBuf(): StreamBuf {
  return { buffer: "" };
}

/**
 * Interrupt gate over streaming reasoning (observe-only).
 *
 * Fed by pi's `message_update` events: `text_delta` (answer) and
 * `thinking_delta` (reasoning, when ingestReasoning). Buffers are per active
 * assistant message (identity-keyed; pi streams one assistant message at a
 * time, so a single active buffer with a message-identity reset is exact).
 *
 * When Cortext reports should_interrupt / at_boundary, the recalled memory is
 * staged on the bus under the SESSION'S SCOPE KEY (the same key the recall
 * handlers use), so a different scope's assembly can never drain it, and the
 * next assembly (the next `context` event, or the next `before_agent_start`)
 * picks it up.
 *
 * pi has no before_agent_finalize / revise hook — unlike the openclaw
 * gateway path, an interrupt CANNOT force a re-pass of the current answer.
 * The gate is observe-only: it stages recall for the next assembly. That is a
 * documented design limit, not a bug.
 */
export interface InterruptGateOptions {
  store: CortextStore;
  bus: InterruptBus;
  log: (line: string) => void;
  ingestReasoning: boolean;
  recallLimit: number;
  scopeKeyProvider: () => string | undefined;
}

export class InterruptGate {
  private buf: { thinking: StreamBuf; assistant: StreamBuf } | null = null;
  private current: AgentMessage | undefined;
  private readonly store: CortextStore;
  private readonly bus: InterruptBus;
  private readonly log: (line: string) => void;
  private readonly ingestReasoning: boolean;
  private readonly recallLimit: number;
  private readonly scopeKeyProvider: () => string | undefined;

  constructor(options: InterruptGateOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.log = options.log;
    this.ingestReasoning = options.ingestReasoning;
    this.recallLimit = options.recallLimit;
    this.scopeKeyProvider = options.scopeKeyProvider;
  }

  onMessageStart(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    this.current = message;
    this.buf = { thinking: emptyBuf(), assistant: emptyBuf() };
    // One unambiguous per-message signal that the gate is receiving events.
    this.log("cortext gate: observing assistant message");
  }

  onMessageUpdate(message: AgentMessage, streamEvent: AssistantMessageEvent): void {
    try {
      if (message.role !== "assistant") return;
      if (message !== this.current) {
        this.current = message;
        this.buf = { thinking: emptyBuf(), assistant: emptyBuf() };
        this.log("cortext gate: observing assistant message");
      }
      let stream: GatedStream | undefined;
      let delta: string;
      if (streamEvent.type === "text_delta") {
        stream = "assistant";
        delta = streamEvent.delta;
      } else if (streamEvent.type === "thinking_delta") {
        if (!this.ingestReasoning) return;
        stream = "thinking";
        delta = streamEvent.delta;
      } else {
        return;
      }
      if (!delta) return;
      const active = this.buf;
      if (!active) return;
      const buf = active[stream];
      buf.buffer += delta;
      if (buf.buffer.length < SEGMENT_MIN_CHARS && !BREAK.test(delta)) return;

      const segment = buf.buffer.trim();
      buf.buffer = "";
      if (segment) this.gate({ stream, segment });
    } catch (err) {
      recordFailure({ name: SPANS.gate });
      // Distinct prefix: must never match the "cortext interrupt gate:" fire
      // logs, or a crashing handler looks like a working gate in the logs.
      this.log(`cortext gate error: ${String(err)}`);
    }
  }

  onMessageEnd(message: AgentMessage): void {
    if (message.role === "assistant" && message === this.current) {
      this.buf = null;
      this.current = undefined;
    }
  }

  private gate({ stream, segment }: { stream: GatedStream; segment: string }): void {
    const scopeKey = this.scopeKeyProvider();
    if (!scopeKey) return;
    const engine = this.store.forScope(scopeKey);
    if (!engine) return; // degraded scope: no recall, no throw
    const span = startSpan({ name: SPANS.recall, attributes: { surface: SURFACES.gate } });
    const ctx = engine.recall({ text: segment, sourceId: `pi/agent/${safe(scopeKey)}/stream/${stream}` });
    endSpan({ span, outcome: ctx ? OUTCOME.ok : OUTCOME.error, attributes: { memoryCount: ctx?.retrieved_memory?.length ?? 0 } });
    if (!ctx) return;

    if (ctx.should_interrupt || ctx.at_boundary) {
      const block = formatMemories({ items: ctx.retrieved_memory, limit: this.recallLimit });
      const stagedCount = block ? (ctx.retrieved_memory?.length ?? 0) : 0;
      if (block) this.bus.stage({ scopeKey, block }); // keyed by SCOPE, not sessionId
      const kind = ctx.should_interrupt ? "interrupt" : "boundary";
      const gateSpan = startSpan({ name: SPANS.gate, attributes: { stream, kind, stagedCount } });
      gateSpan.end();
      this.log(
        `cortext interrupt gate: ${kind} on ${stream} (scope ${scopeKey}) — staged ${ctx.retrieved_memory?.length ?? 0} memories`,
      );
    }
  }
}
