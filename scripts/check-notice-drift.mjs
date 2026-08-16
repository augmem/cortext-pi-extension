#!/usr/bin/env node
/**
 * NOTICE gate: every runtime dependency declared in package.json must be
 * named in NOTICE as a standalone package name (token-boundary match, not an
 * arbitrary substring), and the dependency set must be non-empty. Exit 0 when
 * all are present; exit 1 with the missing names printed otherwise. No args.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const notice = readFileSync(join(root, "NOTICE"), "utf8");
const deps = Object.keys(pkg.dependencies ?? {});

if (deps.length === 0) {
  console.error("notice:verify FAIL: package.json declares no runtime dependencies (vacuous check)");
  process.exit(1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A valid occurrence is not preceded by a name character (letter/digit, '/',
// '@', '-') and not followed by a name character (letter/digit, '-', '/'), so
// e.g. a bare 'api' never matches inside '@opentelemetry/api'.
const present = deps.filter((name) =>
  new RegExp(`(?<![A-Za-z0-9/@'-])${escapeRe(name)}(?![A-Za-z0-9/-])`, "m").test(notice),
);
const missing = deps.filter((name) => !present.includes(name));

if (missing.length > 0) {
  console.error(`NOTICE drift: missing from NOTICE: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`notice:verify OK: all ${deps.length} runtime dependency name(s) present in NOTICE (token-boundary match)`);
