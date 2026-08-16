#!/usr/bin/env node
/**
 * Copies src/pi.d.ts into dist/ after tsc. tsc does not emit declaration-file
 * INPUTS into the outDir, but every emitted dist/*.d.ts imports from "./pi.js"
 * — consumers (pi loading the extension under its own TS surface, or a
 * typechecker resolving our types) need dist/pi.d.ts present for those
 * imports to resolve.
 */
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(join(root, "src", "pi.d.ts"), join(root, "dist", "pi.d.ts"));
