/**
 * Hand-off from the interrupt-gate subscription to the recall surfaces. When
 * the gate fires mid-generation it stages the recalled memory here, keyed by
 * the session's SCOPE KEY (the same key the recall handlers use), so the next
 * assembly (per-LLM-call `context` event, or the next `before_agent_start`)
 * drains and injects it. The staged text was recalled from the session's
 * scoped Cortext store, so draining it introduces no cross-scope leak.
 */
// A staged block whose scope never assembles again (session ended mid-run)
// would otherwise sit forever; keep the bus bounded, dropping the oldest.
const MAX_PENDING = 128;

export class InterruptBus {
  private pending = new Map<string, string>();

  stage(options: { scopeKey: string; block: string }): void {
    const { scopeKey, block } = options;
    if (!block.trim()) return;
    const prev = this.pending.get(scopeKey);
    this.pending.delete(scopeKey); // re-insert as most recent
    this.pending.set(scopeKey, prev ? `${prev}\n${block}` : block);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  take(scopeKey: string): string {
    const block = this.pending.get(scopeKey) ?? "";
    this.pending.delete(scopeKey);
    return block;
  }
}
