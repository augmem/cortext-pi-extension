import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, resolveConfig } from "../dist/config.js";

// Enum values (named per LOCAL-ARG-001).
const SESSION_SCOPE = "session";
const AGENT_SCOPE = "agent";
const FULL_MODE = "full";

test("resolveConfig returns defaults for empty input", () => {
  assert.deepEqual(resolveConfig(undefined), { config: DEFAULTS, rejectedKeys: [] });
  assert.deepEqual(resolveConfig({}), { config: DEFAULTS, rejectedKeys: [] });
});

test("default memory scope is session (multi-user safe)", () => {
  assert.equal(DEFAULTS.memoryScope, "session");
});

test("resolveConfig overrides known keys", () => {
  const { config } = resolveConfig({ focus: 0.9, recallLimit: 3, memoryScope: AGENT_SCOPE });
  assert.equal(config.focus, 0.9);
  assert.equal(config.recallLimit, 3);
  assert.equal(config.memoryScope, AGENT_SCOPE);
  assert.equal(config.sensitivity, DEFAULTS.sensitivity);
});

test("invalid memoryScope falls back to session", () => {
  const { config, rejectedKeys } = resolveConfig({ memoryScope: "bogus" });
  assert.equal(config.memoryScope, SESSION_SCOPE);
  assert.deepEqual(rejectedKeys, ["memoryScope"]);
});

test("invalid compactionMode falls back to hybrid", () => {
  const { config, rejectedKeys } = resolveConfig({ compactionMode: "bogus" });
  assert.equal(config.compactionMode, "hybrid");
  assert.deepEqual(rejectedKeys, ["compactionMode"]);
});

test("invalid protectTail falls back to 6", () => {
  const { config, rejectedKeys } = resolveConfig({ protectTail: -2 });
  assert.equal(config.protectTail, 6);
  assert.deepEqual(rejectedKeys, ["protectTail"]);
});

test("resolveConfig ignores unknown keys and null values", () => {
  const { config, rejectedKeys } = resolveConfig({ bogus: 1, focus: null });
  assert.equal("bogus" in config, false);
  assert.equal(config.focus, DEFAULTS.focus);
  assert.deepEqual(rejectedKeys, [], "null values are absent, not rejected");
});

test("resolveConfig does not mutate DEFAULTS", () => {
  const snapshot = { ...DEFAULTS };
  resolveConfig({ focus: 0.99 });
  assert.deepEqual(DEFAULTS, snapshot);
});

// -- C1: per-field boundary validation ----------------------------------------

test("wrong-typed value for EACH field falls back to the default and reports the key", () => {
  const cases = [
    ["dbPath", 123, DEFAULTS.dbPath],
    ["focus", "0.9", DEFAULTS.focus],
    ["sensitivity", -1, DEFAULTS.sensitivity],
    ["stability", "high", DEFAULTS.stability],
    ["recallLimit", "lots", DEFAULTS.recallLimit],
    ["recallLimit", -1, DEFAULTS.recallLimit],
    ["interruptGate", "no", DEFAULTS.interruptGate],
    ["ingestReasoning", "false", DEFAULTS.ingestReasoning],
    ["autoConsolidate", 0, DEFAULTS.autoConsolidate],
    ["protectTail", "six", DEFAULTS.protectTail],
    ["memoryScope", 7, DEFAULTS.memoryScope],
    ["compactionMode", 3, DEFAULTS.compactionMode],
  ];
  for (const [key, badValue, defaultValue] of cases) {
    const { config, rejectedKeys } = resolveConfig({ [key]: badValue });
    assert.equal(config[key], defaultValue, `${key}: invalid value falls back to the default`);
    assert.ok(rejectedKeys.includes(key), `${key}: rejected key reported`);
  }
});

test("rejected-keys report names the keys (never values), including multiple at once", () => {
  const { config, rejectedKeys } = resolveConfig({ dbPath: 123, focus: "0.9", interruptGate: "no" });
  assert.deepEqual(rejectedKeys.sort(), ["dbPath", "focus", "interruptGate"]);
  assert.equal(config.dbPath, DEFAULTS.dbPath);
  assert.equal(config.focus, DEFAULTS.focus);
  assert.equal(config.interruptGate, DEFAULTS.interruptGate);
  // Keys only — the bad values must not leak into the report.
  assert.ok(!rejectedKeys.includes("123"));
  assert.ok(!rejectedKeys.includes("0.9"));
});

test("valid values for all fields are accepted with an empty rejected report", () => {
  const { config, rejectedKeys } = resolveConfig({
    dbPath: "custom",
    focus: 0.1,
    sensitivity: 1,
    stability: 0,
    recallLimit: 0,
    interruptGate: false,
    ingestReasoning: false,
    autoConsolidate: false,
    memoryScope: AGENT_SCOPE,
    compactionMode: FULL_MODE,
    protectTail: 3,
  });
  assert.deepEqual(rejectedKeys, []);
  assert.deepEqual(config, {
    ...DEFAULTS,
    dbPath: "custom",
    focus: 0.1,
    sensitivity: 1,
    stability: 0,
    recallLimit: 0,
    interruptGate: false,
    ingestReasoning: false,
    autoConsolidate: false,
    memoryScope: AGENT_SCOPE,
    compactionMode: FULL_MODE,
    protectTail: 3,
  });
});

test("dbPath is trimmed on accept; whitespace-only is rejected", () => {
  const trimmed = resolveConfig({ dbPath: "  my-db  " });
  assert.equal(trimmed.config.dbPath, "my-db");
  assert.deepEqual(trimmed.rejectedKeys, []);
  const blank = resolveConfig({ dbPath: "   " });
  assert.equal(blank.config.dbPath, DEFAULTS.dbPath);
  assert.deepEqual(blank.rejectedKeys, ["dbPath"]);
});
