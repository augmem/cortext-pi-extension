#!/usr/bin/env node
/**
 * Per-message ingest-latency bench (feeds the README 'Fast enough' claim).
 *
 * Warms a durable store, then times N single-message ingests of a
 * realistic-length message and reports mean/median/p95. Uses the BUILT
 * dist/ (rebuild first: npm run build). Keep temp artifacts with KEEP_TMP=1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortextEngine } from "../dist/cortext.js";
import { resolveConfig } from "../dist/config.js";

const WARMUP_INGESTS = 20; // warm the durable store before measuring
const MEASURED_INGESTS = 200; // samples for mean/median/p95
const MESSAGE_CHARS = 200; // realistic per-message length (words, not tokens)
const SOURCE_ID = "latency-bench";

const word = "alpha";
const message = Array.from({ length: MESSAGE_CHARS / (word.length + 1) }, () => word).join(" ");

const tmp = mkdtempSync(join(tmpdir(), "cortext-latency-"));
const dbPath = join(tmp, "latency.sqlite");

try {
  const { config } = resolveConfig(undefined);
  const engine = new CortextEngine({ dbPath, cfg: config });

  for (let i = 0; i < WARMUP_INGESTS; i++) engine.ingest({ text: message, sourceId: SOURCE_ID });

  const samplesNs = [];
  for (let i = 0; i < MEASURED_INGESTS; i++) {
    const t0 = process.hrtime.bigint();
    engine.ingest({ text: message, sourceId: SOURCE_ID });
    samplesNs.push(Number(process.hrtime.bigint() - t0));
  }

  const sorted = [...samplesNs].sort((a, b) => a - b);
  const meanMs = samplesNs.reduce((a, b) => a + b, 0) / samplesNs.length / 1e6;
  const medianMs = sorted[Math.floor(sorted.length / 2)] / 1e6;
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)] / 1e6;

  console.log(`latency ingest: mean=${meanMs.toFixed(2)} ms median=${medianMs.toFixed(2)} ms p95=${p95Ms.toFixed(2)} ms (N=${MEASURED_INGESTS}, warm durable store, ${MESSAGE_CHARS}-char messages, temp sqlite)`);
} finally {
  if (process.env.KEEP_TMP !== "1") rmSync(tmp, { recursive: true, force: true });
}
