import type { AgentMessage, CompactionEntry, SessionEntry, SessionMessageEntry } from "./pi.js";
import type { CompactionMode } from "./config.js";

/**
 * Compaction as a window over the session, not transcript surgery.
 *
 * pi natively rebuilds the model context from a CompactionEntry (summary +
 * entries from firstKeptEntryId onward — verified in the installed
 * session-manager buildContextEntries), so this port does NOT carry
 * openclaw's own anchor/self-heal state: we just pick the cut entry.
 *
 * Every message is already in the durable store (message_end ingest), so the
 * extension-provided compaction replaces the summarizer with a bridge note and
 * ZERO LLM calls. The on-disk session file is untouched (pi appends the
 * compaction entry); archived content stays recallable from the durable store.
 *
 * The cut is exchange-aligned: it always lands on a user-message entry, so a
 * kept tail starts on a self-contained exchange (never mid tool-exchange,
 * which would orphan a tool result from its call — pi's own cut-point rule).
 */

export interface CutResult {
  /** Index into the branch entry array of the first entry to KEEP. */
  cutEntryIndex: number;
  /** Context-participating entries (message / custom_message) before the cut. */
  dropped: number;
}

export function messageRoleOf(entry: SessionEntry): string {
  return entry.type === "message" ? String((entry as SessionMessageEntry).message?.role ?? "") : "";
}

/**
 * Choose the index of the first entry to KEEP in `entries` (root -> leaf).
 *
 * - "full": keep from the last user message onward (the current exchange).
 * - "hybrid": keep the last `protectTail` messages, then walk the cut back to
 *   a user message so the tail starts on a self-contained exchange.
 *
 * `boundaryStart` is the previous compaction's kept boundary: nothing before
 * it can be re-kept (pi's buildContextEntries omits it), so the cut never
 * lands earlier. Returns null when no user boundary exists in range — the
 * caller falls back to pi's own validated cut.
 */
export function chooseCut(
  entries: SessionEntry[],
  boundaryStart: number,
  mode: CompactionMode,
  protectTail: number,
): CutResult | null {
  const msgIndices: number[] = [];
  for (let i = boundaryStart; i < entries.length; i++) {
    if (entries[i]!.type === "message") msgIndices.push(i);
  }
  if (msgIndices.length === 0) return null;

  const lastUserAtOrBefore = (fromMsgPos: number): number => {
    for (let i = fromMsgPos; i >= 0; i--) {
      const entryIdx = msgIndices[i]!;
      if (messageRoleOf(entries[entryIdx]!) === "user") return entryIdx;
    }
    return -1;
  };

  let targetMsgPos: number;
  if (mode === "full") {
    targetMsgPos = msgIndices.length - 1;
  } else {
    targetMsgPos = Math.max(0, msgIndices.length - Math.max(1, protectTail));
  }

  const cutEntryIndex = lastUserAtOrBefore(targetMsgPos);
  if (cutEntryIndex < 0 || cutEntryIndex < boundaryStart) return null;

  let dropped = 0;
  for (let i = boundaryStart; i < cutEntryIndex; i++) {
    const t = entries[i]!.type;
    if (t === "message" || t === "custom_message") dropped++;
  }
  return { cutEntryIndex, dropped };
}

/**
 * The previous compaction's kept boundary: nothing before it is reconstructable
 * (pi omits pre-boundary entries from context), so the cut must not land there.
 * 0 when there is no previous compaction on the branch.
 */
export function previousBoundary(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      const prev = entries[i]! as CompactionEntry;
      const idx = entries.findIndex((e) => e.id === prev.firstKeptEntryId);
      return idx >= 0 ? idx : i + 1;
    }
  }
  return 0;
}

/** Crude char/4 token estimate, mirroring the openclaw plugin. */
export function estimateEntryTokens(entries: SessionEntry[]): number {
  let chars = 0;
  for (const e of entries) {
    if (e.type === "message") {
      chars += messageTextLen((e as SessionMessageEntry).message);
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      chars += String((e as { summary?: unknown }).summary ?? "").length;
    }
  }
  return Math.ceil(chars / 4);
}

export function messageTextLen(message: AgentMessage | undefined): number {
  if (!message) return 0;
  if (message.role === "user") {
    return typeof message.content === "string" ? message.content.length : 0;
  }
  if (message.role === "assistant") {
    let n = 0;
    for (const part of message.content) {
      if (part.type === "text") n += part.text.length;
      else if (part.type === "toolCall") n += JSON.stringify(part.arguments ?? {}).length;
    }
    return n;
  }
  if (message.role === "toolResult" || message.role === "custom") {
    if (typeof message.content === "string") return message.content.length;
    let n = 0;
    for (const part of message.content) if (part.type === "text") n += part.text.length;
    return n;
  }
  if (message.role === "bashExecution") return message.command.length + message.output.length;
  if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary.length;
  return 0;
}

/**
 * The bridge summary pi injects in place of the archived prefix (pi frames it
 * as "compacted into the following summary"). No LLM call produced it — the
 * content lives in the durable store and comes back through per-turn recall.
 */
export function bridgeSummary(mode: CompactionMode, dropped: number): string {
  const wm = mode === "full" ? " and its working-memory snapshot" : "";
  return (
    `Archived ${dropped} message(s) to Cortext durable memory ` +
    `(${mode} mode; no summarizer LLM call). The earlier conversation is not in ` +
    `this context window${wm}; relevant parts are recalled from that memory ` +
    `into the prompt each turn and arrive alongside the recent messages below. ` +
    `Continue the conversation naturally; if you need a specific archived ` +
    `detail, ask and it will be recalled.`
  );
}
