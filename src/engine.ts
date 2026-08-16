import type {
  AgentMessage,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  CustomMessage,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionShutdownEvent,
  SessionStartEvent,
} from "./pi.js";
import type { CortextPluginConfig } from "./config.js";
import {
  CortextStore,
  dedupeAgainstWindow,
  formatMemories,
  formatMemoriesExcluding,
  memoryBlock,
  safe,
} from "./cortext.js";
import { bridgeSummary, chooseCut, estimateEntryTokens, previousBoundary } from "./compaction.js";
import type { InterruptBus } from "./store.js";
import { InterruptGate } from "./stream.js";

// Bound serialized tool-call arguments so a huge payload (a file write, a long
// patch) doesn't dominate the store; the result text is ingested separately
// and in full (parity with the openclaw plugin).
const TOOL_ARGS_MAX_CHARS = 2000;

const VERSION = "0.1.0";

/** Render a pi content part as durable text. ToolCall parts render as
 *  "[tool call] name {args}" (args truncated) so the durable record keeps WHAT
 *  the agent did, not just what came back. Thinking/image parts yield "" —
 *  reasoning reaches the store through the streaming gate, not the record. */
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const p = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
  if (p.type === "text" && typeof p.text === "string") return p.text;
  if (p.type === "toolCall" && typeof p.name === "string") {
    let args = "";
    try { args = p.arguments === undefined ? "" : JSON.stringify(p.arguments); } catch { /* unserializable */ }
    if (args.length > TOOL_ARGS_MAX_CHARS) args = args.slice(0, TOOL_ARGS_MAX_CHARS) + "…";
    return `[tool call] ${p.name}${args ? " " + args : ""}`;
  }
  return "";
}

/** Render a message's textual content (string or content-part array) for
 *  durable ingest and window dedupe. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const text = partText(part);
      if (text) parts.push(text);
    }
    return parts.join(" ");
  }
  return "";
}

/** Textual content of any AgentMessage (role-dispatched). */
export function messageTextOf(message: AgentMessage | undefined): string {
  if (!message) return "";
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return messageText(message.content);
    case "bashExecution":
      return `Ran ${message.command}\n${message.output}`;
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return "";
  }
}

/** The latest user text in a message list — the recall query for the
 *  per-LLM-call surface (the user prompt is what the turn is about). */
function latestUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messageTextOf(messages[i]);
  }
  return messageTextOf(messages[messages.length - 1]);
}

/**
 * The extension's handler set: the Cortext loop on pi's event surface.
 *
 *   message_end            -> durable ingest (user / assistant / toolResult)
 *   before_agent_start     -> recall into the system prompt (per user prompt)
 *   context                -> per-LLM-call recall: a display:false custom
 *                             message with memories NOT already in the
 *                             system-prompt block, plus — once the session is
 *                             windowed (a compaction entry is in context) —
 *                             the working-memory snapshot deduped against
 *                             the kept window
 *   session_before_compact -> extension-provided compaction, ZERO LLM calls
 *   message_start/update   -> interrupt gate (observe-only; stages recall)
 *   session_shutdown       -> flush engines (idempotent)
 *
 * Every operation resolves the store to the isolation scope of the current
 * session/project (see CortextStore), so memory never crosses the configured
 * boundary. Recall is not cached across turns — every surface queries Cortext
 * live, so a correction made this turn is reflected on the next.
 */
export class CortextHandlers {
  /** Per scope: the memory lines injected into the system prompt this run,
   *  so the per-LLM-call surface never re-injects the same text. Replaced on
   *  each before_agent_start (a new user prompt recalls fresh). */
  private sysLines = new Map<string, Set<string>>();
  private currentScopeKey: string | undefined;
  private readonly gate: InterruptGate | null;
  private readonly store: CortextStore;
  private readonly bus: InterruptBus;
  private readonly log: (line: string) => void;
  private readonly cfg: CortextPluginConfig;

  constructor(options: { store: CortextStore; bus: InterruptBus; log: (line: string) => void; cfg: CortextPluginConfig }) {
    this.store = options.store;
    this.bus = options.bus;
    this.log = options.log;
    this.cfg = options.cfg;
    this.gate = options.cfg.interruptGate
      ? new InterruptGate({
          store: options.store,
          bus: options.bus,
          log: options.log,
          ingestReasoning: options.cfg.ingestReasoning,
          recallLimit: options.cfg.recallLimit,
          scopeKeyProvider: () => this.currentScopeKey,
        })
      : null;
  }

  private ids(ctx: ExtensionContext): { sessionId: string; cwd: string } {
    return { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
  }

  private scopeKey(ctx: ExtensionContext): string {
    const key = this.store.scopeKey(this.ids(ctx));
    this.currentScopeKey = key;
    return key;
  }

  // -- lifecycle -------------------------------------------------------------

  onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
    this.sysLines.delete(this.scopeKey(ctx));
    this.log(`cortext: session_start (${event.reason})`);
  }

  onSessionShutdown(event: SessionShutdownEvent, _ctx: ExtensionContext): void {
    // Flush open native engines; safe to call more than once.
    this.store.disposeAll();
    this.log(`cortext: session_shutdown (${event.reason})`);
  }

  // -- ingest ----------------------------------------------------------------

  /** Durable per-message ingest. message_end fires for user, assistant, and
   *  toolResult messages; anything else (custom, bashExecution, summaries) is
   *  not part of the conversation record and is skipped. */
  onMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
    const message = event.message;
    this.gate?.onMessageEnd(message);
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
    const text = messageTextOf(message);
    if (!text.trim()) return;
    const scopeKey = this.scopeKey(ctx);
    const engine = this.store.forScope(scopeKey);
    // Consolidation happens at compaction only (autoConsolidate); the engine's
    // throughput hint is deliberately not acted on at ingest (openclaw parity:
    // measured retrieval is identical with or without it).
    const ingested = engine.ingest({ text, sourceId: `pi/${message.role}/${safe(scopeKey)}/ingest` });
    if (ingested === null) this.log(`cortext: ingest failed for ${message.role} (scope ${scopeKey})`);
  }

  // -- recall surfaces ---------------------------------------------------------

  /** Per user prompt: query live recall with the prompt and append a fenced
   *  memory block to the (chained) system prompt. Also drains recall the
   *  interrupt gate staged mid-generation under the same scope key. */
  onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined {
    const scopeKey = this.scopeKey(ctx);
    const engine = this.store.forScope(scopeKey);
    const query = (event.prompt ?? "").trim();
    const recalledCtx = query ? engine.recall({ text: query, sourceId: `pi/agent/${safe(scopeKey)}/assemble` }) : null;
    const recalled = recalledCtx ? formatMemories({ items: recalledCtx.retrieved_memory, limit: this.cfg.recallLimit }) : "";
    const staged = this.bus.take(scopeKey);
    const body = [staged, recalled].filter(Boolean).join("\n");
    const lines = new Set<string>();
    if (body) for (const line of body.split("\n")) if (line.trim()) lines.add(line);
    this.sysLines.set(scopeKey, lines);
    if (!body) return;
    this.log(`cortext: injected ${lines.size} memory line(s) into the system prompt (scope ${scopeKey})`);
    return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + memoryBlock(body) };
  }

  /** Per LLM call (fires before every provider request, so mid-run tool
   *  loops get fresh recall too): append a display:false custom message that
   *  serializes as a user-role message carrying ONLY memories not already in
   *  this run's system-prompt block. When the session is windowed (a
   *  compaction entry is in the context), the live working-memory snapshot
   *  rides along, deduped against the kept window. */
  onContext(event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined {
    const scopeKey = this.scopeKey(ctx);
    const engine = this.store.forScope(scopeKey);
    const query = latestUserText(event.messages).trim();
    const recalledCtx = query ? engine.recall({ text: query, sourceId: `pi/agent/${safe(scopeKey)}/context` }) : null;
    let excluded = this.sysLines.get(scopeKey);
    if (!excluded) {
      excluded = new Set();
      this.sysLines.set(scopeKey, excluded);
    }
    const windowed = event.messages.some((m) => m.role === "compactionSummary");
    const windowTexts = event.messages.map((m) => messageTextOf(m));
    const recalled = recalledCtx
      ? formatMemoriesExcluding({ items: recalledCtx.retrieved_memory, limit: this.cfg.recallLimit, excluded })
      : "";
    const working = windowed && recalledCtx
      ? formatMemoriesExcluding({
          items: dedupeAgainstWindow({ items: recalledCtx.working_memory, windowTexts }),
          limit: this.cfg.recallLimit,
          excluded,
        })
      : "";
    const staged = this.bus.take(scopeKey);
    const body = [staged, recalled, working].filter(Boolean).join("\n");
    if (!body) return;
    for (const line of body.split("\n")) if (line.trim()) excluded.add(line);
    const injected: CustomMessage = {
      role: "custom",
      customType: "cortext-memory",
      content: memoryBlock(body),
      display: false,
      timestamp: Date.now(),
    };
    this.log(`cortext: per-LLM-call recall injected (scope ${scopeKey}${windowed ? ", windowed" : ""})`);
    return { messages: [...event.messages, injected] };
  }

  // -- compaction --------------------------------------------------------------

  /** Extension-provided compaction: move the window, call no summarizer.
   *  Every message is already in the durable store (message_end ingest), so
   *  the returned CompactionEntry carries a bridge summary (no LLM produced
   *  it) and an exchange-aligned firstKeptEntryId; pi natively rebuilds the
   *  context from summary + kept entries. Archived content stays recallable. */
  onSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): SessionBeforeCompactResult | undefined {
    const scopeKey = this.scopeKey(ctx);
    const engine = this.store.forScope(scopeKey);
    if (this.cfg.autoConsolidate) engine.consolidate();
    engine.flush();

    const entries = event.branchEntries;
    const boundaryStart = previousBoundary(entries);
    const cut = chooseCut({ entries, boundaryStart, mode: this.cfg.compactionMode, protectTail: this.cfg.protectTail });

    let firstKeptEntryId: string;
    let dropped: number;
    let cutIndex: number;
    if (cut) {
      cutIndex = cut.cutEntryIndex;
      dropped = cut.dropped;
      firstKeptEntryId = entries[cutIndex]?.id ?? event.preparation.firstKeptEntryId;
    } else {
      // No user-message boundary in range — fall back to pi's own validated
      // cut, still with our zero-LLM summary (nothing about the kept window
      // semantics changes).
      const idx = entries.findIndex((e) => e.id === event.preparation.firstKeptEntryId);
      cutIndex = idx >= 0 ? idx : entries.length;
      firstKeptEntryId = event.preparation.firstKeptEntryId;
      dropped = 0;
      for (let i = boundaryStart; i < cutIndex; i++) {
        const t = entries[i]?.type;
        if (t === "message" || t === "custom_message") dropped++;
      }
    }
    if (dropped === 0) {
      // Nothing before the protected window to archive — there is no durable
      // memory standing behind this cut, so pi's default compaction applies.
      this.log("cortext compaction: nothing before the protected window to archive; pi default applies");
      return;
    }

    const summary = bridgeSummary({ mode: this.cfg.compactionMode, dropped });
    const tokensBefore = event.preparation.tokensBefore;
    const tokensAfter = estimateEntryTokens(entries.slice(cutIndex)) + Math.ceil(summary.length / 4);
    this.log(
      `cortext compaction: archived ${dropped} message(s) ~${tokensBefore} -> ~${tokensAfter} tokens ` +
      `(scope ${scopeKey}, ${this.cfg.compactionMode}, no summarizer LLM call)`,
    );
    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        estimatedTokensAfter: tokensAfter,
        details: {
          engine: "cortext",
          version: VERSION,
          mode: this.cfg.compactionMode,
          dropped,
          scope: this.cfg.memoryScope,
        },
      },
    };
  }

  // -- streaming gate ----------------------------------------------------------

  onMessageStart(event: MessageStartEvent, ctx: ExtensionContext): void {
    this.scopeKey(ctx);
    this.gate?.onMessageStart(event.message);
  }

  onMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void {
    this.scopeKey(ctx);
    this.gate?.onMessageUpdate(event.message, event.assistantMessageEvent);
  }
}
