import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, resolveConfig } from "../dist/config.js";

test("resolveConfig returns defaults for empty input", () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULTS);
  assert.deepEqual(resolveConfig({}), DEFAULTS);
});

test("default memory scope is session (multi-user safe)", () => {
  assert.equal(DEFAULTS.memoryScope, "session");
});

test("resolveConfig overrides known keys", () => {
  const cfg = resolveConfig({ focus: 0.9, recallLimit: 3, memoryScope: "agent" });
  assert.equal(cfg.focus, 0.9);
  assert.equal(cfg.recallLimit, 3);
  assert.equal(cfg.memoryScope, "agent");
  assert.equal(cfg.sensitivity, DEFAULTS.sensitivity);
});

test("invalid memoryScope falls back to session", () => {
  assert.equal(resolveConfig({ memoryScope: "bogus" }).memoryScope, "session");
});

test("invalid compactionMode falls back to hybrid", () => {
  assert.equal(resolveConfig({ compactionMode: "bogus" }).compactionMode, "hybrid");
});

test("invalid protectTail falls back to 6", () => {
  assert.equal(resolveConfig({ protectTail: -2 }).protectTail, 6);
});

test("resolveConfig ignores unknown keys and null values", () => {
  const cfg = resolveConfig({ bogus: 1, focus: null });
  assert.equal("bogus" in cfg, false);
  assert.equal(cfg.focus, DEFAULTS.focus);
});

test("resolveConfig does not mutate DEFAULTS", () => {
  const snapshot = { ...DEFAULTS };
  resolveConfig({ focus: 0.99 });
  assert.deepEqual(DEFAULTS, snapshot);
});
