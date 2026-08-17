#!/usr/bin/env node
/**
 * Test-count gate: the "N tests" figure in the README Verified section must
 * match the actual top-level test() registrations in tests/*.test.mjs. No
 * args.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const readme = readFileSync(join(root, "README.md"), "utf8");
const m = readme.match(/\((\d+) tests,/);
if (!m) {
  console.error("testcount:verify FAIL: README has no '(N tests,' count line (Verified section)")
  process.exit(1);
}
const claimed = Number(m[1]);

let actual = 0;
for (const f of readdirSync(join(root, "tests")).sort()) {
  if (!f.endsWith(".test.mjs")) continue;
  const src = readFileSync(join(root, "tests", f), "utf8");
  actual += (src.match(/^test\(\s*["']/gm) ?? []).length;
}

if (claimed !== actual) {
  console.error(
    `testcount:verify FAIL: README claims ${claimed} tests but tests/*.test.mjs register ${actual} top-level test() calls`,
  );
  process.exit(1);
}
console.log(`testcount:verify OK: README count matches the ${actual} top-level test() registrations`);
