#!/usr/bin/env node
/**
 * Build gate (LOCAL-CUT-001): dist/ must exactly match a fresh build.
 *
 * Rebuilds src into a TEMP outDir (`tsc -p tsconfig.json --outDir <tmp>`,
 * plus the pi.d.ts copy the real build performs), diffs every emitted
 * .js/.d.ts against the corresponding dist/ file, and also flags stale dist/
 * files a fresh build would not emit. Exit 0 when identical; exit 1 with the
 * differing paths printed otherwise. The temp dir is always cleaned up.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const tmp = mkdtempSync(join(tmpdir(), "cortext-pi-drift-"));
const outDir = join(tmp, "out");
const drift = [];

const toPosix = (p) => p.split(sep).join("/");

const walkEmit = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkEmit(p);
    } else if (name.endsWith(".js") || name.endsWith(".d.ts")) {
      const rel = toPosix(relative(outDir, p));
      const inDist = join(distDir, rel);
      if (!existsSync(inDist)) drift.push(`missing in dist/: ${rel}`);
      else if (!readFileSync(p).equals(readFileSync(inDist))) drift.push(`differs: ${rel}`);
    }
  }
};

const walkDist = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkDist(p);
    } else if (name.endsWith(".js") || name.endsWith(".d.ts")) {
      const rel = toPosix(relative(distDir, p));
      if (!existsSync(join(outDir, rel))) drift.push(`stale in dist/ (no fresh emit): ${rel}`);
    }
  }
};

try {
  if (!existsSync(distDir)) {
    console.error("dist/ missing — run `npm run build` first");
    process.exit(1);
  }
  if (!existsSync(tsc)) {
    console.error("typescript not found in node_modules — run `npm ci` first");
    process.exit(1);
  }
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", outDir], {
    cwd: root,
    stdio: "pipe",
  });
  // Mirror the build's pi.d.ts copy (tsc does not emit declaration inputs).
  copyFileSync(join(root, "src", "pi.d.ts"), join(outDir, "pi.d.ts"));
  walkEmit(outDir);
  walkDist(distDir);
} catch (err) {
  console.error("check-dist-drift: fresh build failed:", err.message);
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (drift.length > 0) {
  console.error("dist/ drift detected:");
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}
console.log("dist/ matches a fresh build");
