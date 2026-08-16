import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCut, previousBoundary, bridgeSummary, estimateEntryTokens, messageTextLen } from "../dist/compaction.js";
import { u, at, msgEntry, compactionEntry } from "./helpers.mjs";

// Named per LOCAL-ARG-001 (magic number 0 and mode enums get constants).
const NO_PREVIOUS_BOUNDARY = 0;
const HYBRID = "hybrid";
const FULL = "full";

/** Six exchanges (12 message entries, e1..e12) — user entries e1,e3,e5,e7,e9,e11. */
function sixExchanges() {
  return [
    msgEntry(u({ content: "q1" })), msgEntry(at({ text: "a1" })),
    msgEntry(u({ content: "q2" })), msgEntry(at({ text: "a2" })),
    msgEntry(u({ content: "q3" })), msgEntry(at({ text: "a3" })),
    msgEntry(u({ content: "q4" })), msgEntry(at({ text: "a4" })),
    msgEntry(u({ content: "q5" })), msgEntry(at({ text: "a5" })),
    msgEntry(u({ content: "q6" })), msgEntry(at({ text: "a6" })),
  ];
}

test("hybrid: cut walks back to a user-message boundary (exchange-aligned)", () => {
  const entries = sixExchanges();
  const PROTECT_TAIL = 4;
  const cut = chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: HYBRID, protectTail: PROTECT_TAIL });
  assert.ok(cut);
  // last 4 messages = entries[8..11] -> cut at entries[8] (a user boundary)
  assert.equal(entries[cut.cutEntryIndex], entries[8], "tail starts on the 5th user message");
  assert.equal(entries[cut.cutEntryIndex].message.role, "user", "tail starts on a user message");
  assert.equal(cut.dropped, 8, "first 8 message entries archived");
});

test("hybrid: protectTail larger than the conversation cuts at the first user message", () => {
  const entries = sixExchanges();
  const PROTECT_TAIL = 100;
  const cut = chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: HYBRID, protectTail: PROTECT_TAIL });
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex], entries[0], "cut at the first entry (a user message)");
  assert.equal(cut.dropped, 0, "nothing before the first user message");
});

test("full: cut at the last user message (current exchange only)", () => {
  const entries = sixExchanges();
  const PROTECT_TAIL = 6;
  const cut = chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: FULL, protectTail: PROTECT_TAIL });
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex], entries[10], "last user message kept, its answer after it");
  assert.equal(cut.dropped, 10);
});

test("cut never lands before the previous compaction's kept boundary", () => {
  // previous compaction kept from the 3rd entry onward; the kept entry is an
  // assistant message, so the first user boundary in range is the 5th entry.
  const eOld = msgEntry(u({ content: "old" }));
  const eOld2 = msgEntry(at({ text: "old2" }));
  const eKept = msgEntry(u({ content: "kept-q" }));
  const entries = [
    eOld,
    eOld2,
    compactionEntry({ id: "c1", firstKeptEntryId: eOld2.id }),
    eKept,
    msgEntry(at({ text: "kept-a" })),
    msgEntry(u({ content: "q" })),
    msgEntry(at({ text: "a" })),
    msgEntry(u({ content: "q2" })),
    msgEntry(at({ text: "a2" })),
    msgEntry(u({ content: "q3" })),
    msgEntry(at({ text: "a3" })),
  ];
  const boundary = previousBoundary(entries);
  assert.equal(boundary, 1, "boundary is the index of the previous kept entry");
  const PROTECT_TAIL = 6;
  const cut = chooseCut({ entries, boundaryStart: boundary, mode: FULL, protectTail: PROTECT_TAIL });
  assert.ok(cut, "a user boundary exists in range");
  assert.ok(cut.cutEntryIndex >= boundary, "cut respects the boundary");
});

test("no user boundary in range -> null (caller falls back to pi's cut)", () => {
  const entries = [msgEntry(at({ text: "only assistant" }))];
  const PROTECT_TAIL = 2;
  assert.equal(chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: HYBRID, protectTail: PROTECT_TAIL }), null);
  assert.equal(chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: FULL, protectTail: PROTECT_TAIL }), null);
});

test("dropped counts context-participating entries only", () => {
  const entries = [
    msgEntry(u({ content: "q1" })), msgEntry(at({ text: "a1" })),
    { type: "label", id: "l1", parentId: null, timestamp: "t", label: "x" },
    msgEntry(u({ content: "q2" })), msgEntry(at({ text: "a2" })),
  ];
  const PROTECT_TAIL = 1;
  const cut = chooseCut({ entries, boundaryStart: NO_PREVIOUS_BOUNDARY, mode: FULL, protectTail: PROTECT_TAIL });
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex].message.role, "user", "cut at the last user message");
  assert.equal(cut.dropped, 2, "label entries are not messages");
});

test("previousBoundary: 0 when no previous compaction", () => {
  assert.equal(previousBoundary(sixExchanges()), 0);
});

test("previousBoundary: falls back to after the compaction entry when kept id is missing", () => {
  const entries = [msgEntry(u({ content: "q" })), compactionEntry({ id: "c1", firstKeptEntryId: "does-not-exist" }), msgEntry(at({ text: "a" }))];
  assert.equal(previousBoundary(entries), 2);
});

test("bridgeSummary names the archive and the zero-LLM property", () => {
  const DROPPED_HYBRID = 8;
  const DROPPED_FULL = 2;
  const s = bridgeSummary({ mode: HYBRID, dropped: DROPPED_HYBRID });
  assert.match(s, /Archived 8 message/);
  assert.match(s, /no summarizer LLM call/i);
  assert.match(s, /recalled/i);
  assert.match(bridgeSummary({ mode: FULL, dropped: DROPPED_FULL }), /working-memory snapshot/);
});

test("estimateEntryTokens scales with message content", () => {
  const small = [msgEntry(u({ content: "hi" }))];
  const big = [msgEntry(u({ content: "x".repeat(4000) }))];
  assert.ok(estimateEntryTokens(big) > estimateEntryTokens(small));
  assert.equal(estimateEntryTokens(small), 1);
});

test("messageTextLen handles every role", () => {
  assert.equal(messageTextLen({ role: "user", content: "abcd", timestamp: 1 }), 4);
  assert.equal(
    messageTextLen({
      role: "assistant",
      content: [{ type: "text", text: "ab" }, { type: "toolCall", id: "c", name: "bash", arguments: { a: 1 } }],
      timestamp: 1,
    }),
    2 + '{"a":1}'.length,
  );
  assert.equal(messageTextLen(undefined), 0);
});
