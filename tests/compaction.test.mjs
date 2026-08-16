import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCut, previousBoundary, bridgeSummary, estimateEntryTokens, messageTextLen } from "../dist/compaction.js";
import { u, at, msgEntry, compactionEntry } from "./helpers.mjs";

/** Six exchanges (12 message entries, e1..e12) — user entries e1,e3,e5,e7,e9,e11. */
function sixExchanges() {
  return [
    msgEntry(u("q1")), msgEntry(at("a1")),
    msgEntry(u("q2")), msgEntry(at("a2")),
    msgEntry(u("q3")), msgEntry(at("a3")),
    msgEntry(u("q4")), msgEntry(at("a4")),
    msgEntry(u("q5")), msgEntry(at("a5")),
    msgEntry(u("q6")), msgEntry(at("a6")),
  ];
}

test("hybrid: cut walks back to a user-message boundary (exchange-aligned)", () => {
  const entries = sixExchanges();
  const cut = chooseCut(entries, 0, "hybrid", 4);
  assert.ok(cut);
  // last 4 messages = entries[8..11] -> cut at entries[8] (a user boundary)
  assert.equal(entries[cut.cutEntryIndex], entries[8], "tail starts on the 5th user message");
  assert.equal(entries[cut.cutEntryIndex].message.role, "user", "tail starts on a user message");
  assert.equal(cut.dropped, 8, "first 8 message entries archived");
});

test("hybrid: protectTail larger than the conversation cuts at the first user message", () => {
  const entries = sixExchanges();
  const cut = chooseCut(entries, 0, "hybrid", 100);
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex], entries[0], "cut at the first entry (a user message)");
  assert.equal(cut.dropped, 0, "nothing before the first user message");
});

test("full: cut at the last user message (current exchange only)", () => {
  const entries = sixExchanges();
  const cut = chooseCut(entries, 0, "full", 6);
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex], entries[10], "last user message kept, its answer after it");
  assert.equal(cut.dropped, 10);
});

test("cut never lands before the previous compaction's kept boundary", () => {
  // previous compaction kept from the 3rd entry onward; the kept entry is an
  // assistant message, so the first user boundary in range is the 5th entry.
  const eOld = msgEntry(u("old"));
  const eOld2 = msgEntry(at("old2"));
  const eKept = msgEntry(u("kept-q"));
  const entries = [
    eOld,
    eOld2,
    compactionEntry("c1", eOld2.id),
    eKept,
    msgEntry(at("kept-a")),
    msgEntry(u("q")),
    msgEntry(at("a")),
    msgEntry(u("q2")),
    msgEntry(at("a2")),
    msgEntry(u("q3")),
    msgEntry(at("a3")),
  ];
  const boundary = previousBoundary(entries);
  assert.equal(boundary, 1, "boundary is the index of the previous kept entry");
  const cut = chooseCut(entries, boundary, "full", 6);
  assert.ok(cut, "a user boundary exists in range");
  assert.ok(cut.cutEntryIndex >= boundary, "cut respects the boundary");
});

test("no user boundary in range -> null (caller falls back to pi's cut)", () => {
  const entries = [msgEntry(at("only assistant"))];
  assert.equal(chooseCut(entries, 0, "hybrid", 2), null);
  assert.equal(chooseCut(entries, 0, "full", 2), null);
});

test("dropped counts context-participating entries only", () => {
  const entries = [
    msgEntry(u("q1")), msgEntry(at("a1")),
    { type: "label", id: "l1", parentId: null, timestamp: "t", label: "x" },
    msgEntry(u("q2")), msgEntry(at("a2")),
  ];
  const cut = chooseCut(entries, 0, "full", 1);
  assert.ok(cut);
  assert.equal(entries[cut.cutEntryIndex].message.role, "user", "cut at the last user message");
  assert.equal(cut.dropped, 2, "label entries are not messages");
});

test("previousBoundary: 0 when no previous compaction", () => {
  assert.equal(previousBoundary(sixExchanges()), 0);
});

test("previousBoundary: falls back to after the compaction entry when kept id is missing", () => {
  const entries = [msgEntry(u("q")), compactionEntry("c1", "does-not-exist"), msgEntry(at("a"))];
  assert.equal(previousBoundary(entries), 2);
});

test("bridgeSummary names the archive and the zero-LLM property", () => {
  const s = bridgeSummary("hybrid", 8);
  assert.match(s, /Archived 8 message/);
  assert.match(s, /no summarizer LLM call/i);
  assert.match(s, /recalled/i);
  assert.match(bridgeSummary("full", 2), /working-memory snapshot/);
});

test("estimateEntryTokens scales with message content", () => {
  const small = [msgEntry(u("hi"))];
  const big = [msgEntry(u("x".repeat(4000)))];
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
