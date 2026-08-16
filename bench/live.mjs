#!/usr/bin/env node
/**
 * Live proof against the REAL pi CLI (RPC mode) in an isolated temp project.
 *
 * Runs the extension under a real pi session and verifies, with positive AND
 * negative controls:
 *
 *   1. ingest-mechanism   extension active, recall injections logged, zero
 *                         extension_error / gate-error lines
 *   2. ingest-durable     a FRESH handle on the same SQLite DB (session scope
 *                         of S1) recalls the needle — durable cross-process
 *   3. isolation-store    a fresh handle on scope S2 does NOT recall the needle
 *   4. isolation-session  a different live session's model does not know the needle
 *   5. compaction-zero    compact -> extension-provided CompactionEntry
 *                         (details.engine="cortext"), NO usage (zero LLM calls)
 *   6. compaction-window  the needle entry is provably archived (before
 *                         firstKeptEntryId on the branch)
 *   7. recall-post        after compaction the model answers the needle — the
 *                         needle exists ONLY in the archived prefix, so this
 *                         can only come from Cortext injection
 *   8. gate-observe       the streaming gate observed assistant messages and
 *                         processed turns without error (fire count reported;
 *                         fires are state-dependent, so observation-without-error
 *                         is the live claim, as in the openclaw gateway bench)
 *
 * Isolation: temp project dir (no .pi/ -> nothing to trust), --no-extensions
 * (only our explicit -e loads; the user's global extensions never run),
 * --session-dir under the temp dir, CORTEX_PI_CONFIG env with a unique dbPath
 * (which also proves the env config path live). The user's ~/.pi/agent is
 * read-only for this script, except the unique bench store dir which is
 * removed on success.
 *
 * Exit 0 only if every control passes. Keep temp artifacts with KEEP_TMP=1.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CortextEngine, memoryText, safe } from "../dist/cortext.js";
import { resolveConfig } from "../dist/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const EXTENSION = join(REPO, "dist", "index.js");

const PI_BIN = process.env.PI_BIN ?? "/Users/gabrielwillen/.nvm/versions/node/v24.11.1/bin/pi";
const PROVIDER = process.env.BENCH_PROVIDER ?? "qwen3.8";
const MODEL = process.env.BENCH_MODEL ?? "Qwen3.8-27B";
const THINKING = process.env.BENCH_THINKING ?? "low";
const NEEDLE = "ZEBRAQUININE42";
const KEEP_TMP = process.env.KEEP_TMP === "1";

const dbPath = `bench-live-${Date.now()}`;
const benchConfig = { dbPath, memoryScope: "session" };

let tmpDir = "";
let projectDir = "";
let sessionsDir = "";
let storeDir = join(homedir(), ".pi", "agent", "cortext", safe(dbPath));
let child = null;
let results = [];
let stderrLines = [];
let allEvents = [];
let settledSeen = 0;
let seq = 0;

function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${evidence ? `  [${evidence}]` : ""}`);
}
function failNow(name, evidence) {
  record(name, false, evidence);
  cleanup(false);
  summary();
  process.exit(1);
}
function summary() {
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nbench: ${results.length - failed}/${results.length} controls passed`);
}

// --------------------------------------------------------------------------
// RPC transport (strict JSONL: split on \n only, strip trailing \r)
// --------------------------------------------------------------------------
const pending = new Map();
let stdoutBuf = "";

function rpcSend(obj) {
  const id = `req-${++seq}`;
  const msg = { ...obj, id };
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout waiting for response to ${obj.type}`));
    }, obj.__timeoutMs ?? 180000);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
  child.stdin.write(JSON.stringify(msg) + "\n");
  return p;
}

function onStdoutChunk(chunk) {
  stdoutBuf += chunk.toString("utf-8");
  for (;;) {
    const i = stdoutBuf.indexOf("\n");
    if (i === -1) break;
    let line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    allEvents.push(ev);
    if (ev.type === "response") {
      const p = pending.get(ev.id);
      if (p) { pending.delete(ev.id); p.resolve(ev); }
    } else if (ev.type === "extension_ui_request") {
      // Never block on a dialog: cancel anything our extension (or the
      // harness) might surface.
      try { child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true }) + "\n"); } catch { /* ignore */ }
    } else if (ev.type === "agent_settled") {
      settledSeen++;
    }
  }
}

// --------------------------------------------------------------------------
// Bench steps
// --------------------------------------------------------------------------
async function main() {
  if (!existsSync(EXTENSION)) failNow("preflight", `dist/index.js missing — run npm run build first (${EXTENSION})`);

  tmpDir = mkdtempSync(join(tmpdir(), "cortext-pi-bench-"));
  projectDir = mkdtempSync(join(tmpDir, "project-"));
  sessionsDir = mkdtempSync(join(tmpDir, "sessions-"));
  // Project-level settings: tiny keepRecentTokens so a short bench session has
  // archivable content (default 20k would make "compact" reject as too small).
  // This also exercises project-settings loading (trusted via --approve).
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 50 } }, null, 2),
  );

  child = spawn(
    PI_BIN,
    [
      "--mode", "rpc",
      "--no-extensions",
      "-e", EXTENSION,
      "--approve",
      "--no-context-files",
      "--offline",
      "--no-tools",
      "--provider", PROVIDER,
      "--model", MODEL,
      "--thinking", THINKING,
      "--session-dir", sessionsDir,
    ],
    { cwd: projectDir, env: { ...process.env, CORTEX_PI_CONFIG: JSON.stringify(benchConfig) }, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.on("data", onStdoutChunk);
  child.on("error", (err) => {
    console.error(`bench: fatal: failed to spawn pi: ${err.code ?? ""} ${err.message}`);
    cleanup(false);
    summary();
    process.exit(1);
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString("utf-8").split("\n")) {
      if (line.trim()) stderrLines.push(line);
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));

  // Handshake: poll get_state until the session is up (pi may still be starting).
  let state = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await rpcSend({ type: "get_state", __timeoutMs: 5000 }).catch(() => null);
      if (res?.success) { state = res.data; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state?.sessionId) {
    const extErr = allEvents.filter((e) => e.type === "extension_error").slice(0, 3);
    failNow("preflight", `pi RPC did not report a session in 30s (extension_error: ${JSON.stringify(extErr)})`);
  }
  const s1 = state.sessionId;
  console.log(`bench: pi ${state.model?.provider ?? PROVIDER}/${state.model?.id ?? MODEL} thinking=${state.thinkingLevel ?? THINKING} session=${s1}`);

  const prompt = async (message) => {
    const before = settledSeen;
    const res = await rpcSend({ type: "prompt", message });
    if (!res.success) throw new Error(`prompt rejected: ${res.error ?? "unknown"}`);
    // Wait for THIS prompt's run to settle (no retry/compaction/follow-up left).
    const deadline = Date.now() + 180000;
    while (settledSeen === before) {
      if (Date.now() > deadline) throw new Error("agent_settled timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
    const last = await rpcSend({ type: "get_last_assistant_text" });
    return last.data?.text ?? "";
  };

  // 1) Establish the needle (exchange 1 of 5).
  await prompt(
    `I am about to tell you a secret codename to remember for later. ` +
    `The codename is ${NEEDLE}. Remember it exactly as written. Reply with just: OK.`,
  );
  // 2) Filler exchanges (substantial replies) so the session comfortably
  //    exceeds keepRecentTokens and the hybrid protectTail window (6 messages)
  //    leaves the needle exchange archivable.
  const fillers = [
    "Write a four-sentence poem about a lighthouse keeper. Then stop.",
    "Describe, in three sentences, why honey never spoils. Then stop.",
    "Write a two-sentence haiku-style description of static electricity. Then stop.",
    "In three short sentences, explain how a compass works. Then stop.",
  ];
  for (const f of fillers) {
    await prompt(f);
  }

  // 3) Compact — must be extension-provided, zero LLM calls.
  const compactRes = await rpcSend({ type: "compact" });
  if (!compactRes.success) failNow("compaction-zero", `compact rejected: ${compactRes.error}`);
  const compactEv = allEvents.find((e) => e.type === "compaction_end");
  if (!compactEv?.result) failNow("compaction-zero", `no compaction_end result: ${JSON.stringify(compactEv)}`);
  const cr = compactEv.result;
  const zeroLlm = cr.details?.engine === "cortext" && cr.usage === undefined && /Cortext/.test(cr.summary ?? "");
  record(
    "compaction-zero (extension CompactionEntry, no summarizer LLM call)",
    zeroLlm,
    `details.engine=${cr.details?.engine ?? "none"}, usage=${cr.usage === undefined ? "absent" : "PRESENT"}, firstKeptEntryId=${cr.firstKeptEntryId ?? "none"}, summary~=${(cr.summary ?? "").slice(0, 60)}...`,
  );
  if (!zeroLlm) failNow("compaction-zero", "see above");

  // 4) Prove the needle is archived: on the branch, the needle entry must be
  //    before firstKeptEntryId (not in the rebuilt kept window).
  const entriesRes = await rpcSend({ type: "get_entries" });
  const entries = entriesRes.data?.entries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const branch = [];
  for (let id = entriesRes.data?.leafId; id && byId.has(id); id = byId.get(id)?.parentId) branch.unshift(byId.get(id));
  const keptStart = branch.findIndex((e) => e.id === cr.firstKeptEntryId);
  const needleEntry = branch.find((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content ?? "").includes(NEEDLE));
  const cmpEntry = branch.find((e) => e.type === "compaction");
  const archived = Boolean(needleEntry) && keptStart >= 0 && branch.indexOf(needleEntry) < keptStart;
  record(
    "compaction-window (needle provably archived, exchange-aligned cut)",
    archived,
    `needleEntry=${needleEntry?.id ?? "NOT FOUND"}, firstKeptEntryId index=${keptStart}, branch=${branch.length} entries, compaction fromExtension=${cmpEntry?.fromExtension ?? cmpEntry?.fromHook ?? "n/a"}`,
  );
  if (!archived) failNow("compaction-window", "see above");

  // 5) The crown control: needle exists ONLY in the archived prefix — the
  //    model can answer it only from Cortext injection. One retry allowed
  //    (a second turn re-runs recall fresh by design).
  let qa = await prompt(`What was the secret codename I told you to remember? Answer with just the codename.`);
  let attempts = 1;
  if (!qa.includes(NEEDLE)) {
    qa = await prompt(`Try again — what was the exact secret codename I told you to remember? Answer with just the codename.`);
    attempts = 2;
  }
  record(
    "recall-post-compaction (archived-only needle answered from memory)",
    qa.includes(NEEDLE),
    `attempts=${attempts}, answer~="${qa.slice(0, 80)}"`,
  );
  if (!qa.includes(NEEDLE)) failNow("recall-post-compaction", "see above");

  // 6) Negative session: new session, same process, same store base — must NOT
  //    know the needle (session scope = one store per session).
  const newRes = await rpcSend({ type: "new_session" });
  if (!newRes.success) failNow("isolation-session", `new_session rejected: ${newRes.error}`);
  const s2state = (await rpcSend({ type: "get_state" })).data;
  const s2 = s2state.sessionId;
  if (s2 === s1) failNow("isolation-session", "new_session returned the same session id");
  const s2answer = await prompt(`What is the secret codename I told you to remember? I am sure I told it to you in this conversation. Answer with just the codename, or say I never told you.`);
  record(
    "isolation-session (different session cannot read the fact, live model check)",
    !s2answer.includes(NEEDLE),
    `s2=${s2}, answer~="${s2answer.slice(0, 80)}"`,
  );
  if (s2answer.includes(NEEDLE)) failNow("isolation-session", "see above");

  // 7) Store-level controls with FRESH handles (durable + cross-scope).
  const cfg = resolveConfig(benchConfig);
  const engineFor = (sessionId) =>
    new CortextEngine(join(storeDir, `s-${safe(sessionId)}.sqlite`), cfg);
  const recallText = (sessionId) => {
    const ctx = engineFor(sessionId).recall("secret codename to remember", "bench/verify");
    if (!ctx) return "";
    return (ctx.retrieved_memory ?? []).map(memoryText).join("\n");
  };
  const s1Recall = recallText(s1);
  record(
    "ingest-durable (fresh handle on S1 store recalls the needle)",
    s1Recall.includes(NEEDLE),
    `retrieved ${s1Recall.split("\n").filter(Boolean).length} memor(y/ies)`,
  );
  const s2Recall = recallText(s2);
  record(
    "isolation-store (fresh handle on S2 store does NOT recall the needle)",
    !s2Recall.includes(NEEDLE),
    `s2 retrieved text~="${s2Recall.slice(0, 60)}"`,
  );
  if (!s1Recall.includes(NEEDLE) || s2Recall.includes(NEEDLE)) failNow("ingest-durable/isolation-store", "see above");

  // 8) Mechanism + gate observation from stderr / events.
  const extLines = stderrLines.filter((l) => l.includes("cortext:"));
  const gateErrors = extLines.filter((l) => l.includes("cortext gate error"));
  const extErrEvents = allEvents.filter((e) => e.type === "extension_error" && e.extensionPath === EXTENSION);
  const observed = extLines.filter((l) => l.includes("cortext gate: observing assistant message")).length;
  const injections = extLines.filter((l) => l.includes("cortext: injected") || l.includes("per-LLM-call recall injected")).length;
  const fires = extLines.filter((l) => /cortext interrupt gate: (interrupt|boundary)/.test(l)).length;
  record(
    "gate-observe (streaming gate observed, no handler errors)",
    observed > 0 && gateErrors.length === 0 && extErrEvents.length === 0,
    `observing=${observed}, injections=${injections}, gate fires=${fires}, gateErrors=${gateErrors.length}, extension_errors=${extErrEvents.length}`,
  );
  record(
    "ingest-mechanism (extension active, recall injected, no handler errors)",
    extLines.some((l) => l.includes("cortext extension active")) && injections > 0 && extErrEvents.length === 0,
    `active-line present, injection lines=${injections}`,
  );

  cleanup(true);
  summary();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

function cleanup(passed) {
  try {
    if (child && !child.killed) child.kill("SIGTERM");
  } catch { /* already dead */ }
  if (passed && !KEEP_TMP) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`bench: cleaned up ${tmpDir} and ${storeDir}`);
  } else {
    console.log(`bench: KEEP artifacts — tmp=${tmpDir} store=${storeDir} (KEEP_TMP=${KEEP_TMP})`);
  }
}

main().catch((err) => {
  console.error(`bench: fatal: ${err?.stack ?? err}`);
  cleanup(false);
  summary();
  process.exit(1);
});
