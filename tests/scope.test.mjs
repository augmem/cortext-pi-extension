import { test } from "node:test";
import assert from "node:assert/strict";
import { CortextStore } from "../dist/cortext.js";
import { resolveConfig } from "../dist/config.js";

const store = (scope) => new CortextStore(resolveConfig({ memoryScope: scope }), "/tmp/x");

test("session scope: distinct session ids give distinct stores (no collapse)", () => {
  const s = store("session");
  const keys = ["S1", "S2", "abc-123", "X"].map((sid) => s.scopeKey({ sessionId: sid }));
  assert.equal(new Set(keys).size, keys.length, "every distinct session id maps to a distinct scope");
});

test("session scope: absent sessionId normalizes", () => {
  const s = store("session");
  assert.equal(s.scopeKey({}), s.scopeKey({ sessionId: "session" }));
});

test("agent scope: distinct projects (cwd) separate stores", () => {
  const s = store("agent");
  assert.notEqual(s.scopeKey({ cwd: "/tmp/project-a" }), s.scopeKey({ cwd: "/tmp/project-b" }));
});

test("agent scope: absent/empty cwd normalizes to main", () => {
  const s = store("agent");
  const main = s.scopeKey({ cwd: "/tmp/project-a" });
  assert.notEqual(main, s.scopeKey({}), "absent cwd is 'main', a distinct project");
  assert.equal(s.scopeKey({}), s.scopeKey({ cwd: "/" }));
});

test("agent scope: two projects with the same basename share a store (documented identity)", () => {
  const s = store("agent");
  assert.equal(
    s.scopeKey({ cwd: "/home/u/work/proj" }),
    s.scopeKey({ cwd: "/elsewhere/proj" }),
    "project identity is the cwd basename — the deterministic identity documented in the README",
  );
});

test("global scope: one shared store regardless of ids", () => {
  const s = store("global");
  assert.equal(s.scopeKey({ sessionId: "A", cwd: "/x" }), s.scopeKey({ sessionId: "B", cwd: "/y" }));
  assert.equal(s.scopeKey({}), "global");
});

test("scope key is deterministic and sanitized", () => {
  const s = store("session");
  const k = s.scopeKey({ sessionId: "a b/c:d" });
  assert.equal(k, "s-a_b_c_d");
});
