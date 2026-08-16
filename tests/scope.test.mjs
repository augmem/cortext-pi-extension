import { test } from "node:test";
import assert from "node:assert/strict";
import { CortextStore } from "../dist/cortext.js";
import { resolveConfig } from "../dist/config.js";
import { silentLog } from "./helpers.mjs";

// Enum values (named per LOCAL-ARG-001).
const SESSION_SCOPE = "session";
const AGENT_SCOPE = "agent";
const GLOBAL_SCOPE = "global";

const store = (scope) => new CortextStore({ cfg: resolveConfig({ memoryScope: scope }).config, baseDir: "/tmp/x", log: silentLog });

test("session scope: distinct session ids give distinct stores (no collapse)", () => {
  const s = store(SESSION_SCOPE);
  const keys = ["S1", "S2", "abc-123", "X"].map((sid) => s.scopeKey({ sessionId: sid }));
  assert.equal(new Set(keys).size, keys.length, "every distinct session id maps to a distinct scope");
});

test("session scope: absent sessionId normalizes", () => {
  const s = store(SESSION_SCOPE);
  assert.equal(s.scopeKey({}), s.scopeKey({ sessionId: "session" }));
});

test("agent scope: distinct projects (cwd) separate stores", () => {
  const s = store(AGENT_SCOPE);
  assert.notEqual(s.scopeKey({ cwd: "/tmp/project-a" }), s.scopeKey({ cwd: "/tmp/project-b" }));
});

test("agent scope: absent/empty cwd normalizes to main", () => {
  const s = store(AGENT_SCOPE);
  const main = s.scopeKey({ cwd: "/tmp/project-a" });
  assert.notEqual(main, s.scopeKey({}), "absent cwd is 'main', a distinct project");
  assert.equal(s.scopeKey({}), s.scopeKey({ cwd: "/" }));
});

test("agent scope: two projects with the same basename share a store (documented identity)", () => {
  const s = store(AGENT_SCOPE);
  assert.equal(
    s.scopeKey({ cwd: "/home/u/work/proj" }),
    s.scopeKey({ cwd: "/elsewhere/proj" }),
    "project identity is the cwd basename — the deterministic identity documented in the README",
  );
});

test("agent scope: Windows cwd paths yield the real basename (both separators)", () => {
  const s = store(AGENT_SCOPE);
  const winKey = s.scopeKey({ cwd: "C:\\Users\\gab\\proj-win" });
  assert.equal(winKey, s.scopeKey({ cwd: "/tmp/proj-win" }), "backslashed cwd resolves to the same basename");
  assert.notEqual(winKey, s.scopeKey({ cwd: "/tmp/other" }), "distinct basenames stay distinct");
});

test("global scope: one shared store regardless of ids", () => {
  const s = store(GLOBAL_SCOPE);
  assert.equal(s.scopeKey({ sessionId: "A", cwd: "/x" }), s.scopeKey({ sessionId: "B", cwd: "/y" }));
  assert.equal(s.scopeKey({}), GLOBAL_SCOPE);
});

test("scope key is deterministic and sanitized", () => {
  const s = store(SESSION_SCOPE);
  const k = s.scopeKey({ sessionId: "a b/c:d" });
  assert.equal(k, "s-a_b_c_d");
});
