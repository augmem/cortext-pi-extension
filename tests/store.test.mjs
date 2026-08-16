import { test } from "node:test";
import assert from "node:assert/strict";
import { InterruptBus } from "../dist/store.js";

test("stage accumulates and take drains", () => {
  const bus = new InterruptBus();
  bus.stage({ scopeKey: "s", block: "- a" });
  bus.stage({ scopeKey: "s", block: "- b" });
  assert.equal(bus.take("s"), "- a\n- b");
  assert.equal(bus.take("s"), "", "take clears the staged block");
});

test("stage ignores blank blocks", () => {
  const bus = new InterruptBus();
  bus.stage({ scopeKey: "s", block: "   " });
  assert.equal(bus.take("s"), "");
});

test("staging is isolated per scope", () => {
  const bus = new InterruptBus();
  bus.stage({ scopeKey: "a", block: "- x" });
  assert.equal(bus.take("b"), "");
  assert.equal(bus.take("a"), "- x");
});

test("the bus is bounded, dropping the oldest", () => {
  const bus = new InterruptBus();
  for (let i = 0; i < 200; i++) bus.stage({ scopeKey: `s${i}`, block: "- m" });
  assert.equal(bus.take("s0"), "", "oldest scope was evicted");
  assert.equal(bus.take("s199"), "- m", "newest scope retained");
});
