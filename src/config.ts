import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryScope = "agent" | "session" | "global";

/** How Cortext compacts the model-visible window (`session_before_compact`):
 *  - "hybrid": keep system prompt + recalled long-term memory + a verbatim
 *    tail of recent messages (exchange-aligned). Safe default.
 *  - "full": keep system prompt + Cortext memory only (long-term recall plus
 *    the live working-memory snapshot); the verbatim window shrinks to the
 *    current exchange. Maximum token savings — memory IS the context. */
export type CompactionMode = "hybrid" | "full";

export interface CortextPluginConfig {
  /** Directory (under the pi agent's `cortext` base dir) for the stores. */
  dbPath: string;
  /** Isolation boundary for memory. "session" (default): one store per
   *  session — safe when a project serves multiple people. "agent": one store
   *  per project (cwd) — persists across that project's sessions; use only
   *  for single-user projects. "global": one shared store. */
  memoryScope: MemoryScope;
  focus: number;
  sensitivity: number;
  stability: number;
  recallLimit: number;
  interruptGate: boolean;
  ingestReasoning: boolean;
  autoConsolidate: boolean;
  /** Compaction window mode (see CompactionMode). */
  compactionMode: CompactionMode;
  /** Hybrid mode: number of trailing messages kept verbatim (the cut is
   *  walked back to a user-message boundary so the tail is a self-contained
   *  exchange). */
  protectTail: number;
}

// focus/stability defaults mirror the tuning carried over from the Hermes
// provider bench (F=.45 S=.50 T=.50). See cortext-hermes-plugin/bench/README.md.
export const DEFAULTS: CortextPluginConfig = {
  dbPath: "cortext",
  memoryScope: "session",
  focus: 0.45,
  sensitivity: 0.5,
  stability: 0.5,
  recallLimit: 12,
  interruptGate: true,
  ingestReasoning: true,
  autoConsolidate: true,
  compactionMode: "hybrid",
  protectTail: 6,
};

const SCOPES: MemoryScope[] = ["agent", "session", "global"];
const COMPACTION_MODES: CompactionMode[] = ["hybrid", "full"];

/** Default on-disk config file (independent of `dbPath`). */
export const CONFIG_FILE = join(homedir(), ".pi", "agent", "cortext", "config.json");

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Raw config source. pi has no per-extension config surface (verified against
 * the installed 0.84.2 Settings types), so config resolves in order:
 *   1. CORTEX_PI_CONFIG env var (JSON object) — most specific, wins
 *   2. CONFIG_FILE (JSON object)
 *   3. DEFAULTS (applied by resolveConfig)
 * A malformed source is skipped, never fatal: memory must not break the agent.
 */
export function loadRawConfig(configFile: string = CONFIG_FILE): Record<string, unknown> | undefined {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = asObject(JSON.parse(readFileSync(configFile, "utf-8")));
  } catch { /* no config file — env/defaults apply */ }
  const env = process.env.CORTEX_PI_CONFIG;
  if (env && env.trim()) {
    try {
      const parsed = asObject(JSON.parse(env));
      if (parsed) raw = { ...(raw ?? {}), ...parsed };
    } catch { /* malformed env JSON — keep file/defaults */ }
  }
  return raw;
}

/** Result of config resolution: the validated config plus the KEYS (never
 *  values — they may be sensitive or unprintable) of any raw source field
 *  that failed validation and fell back to DEFAULTS. */
export interface ResolvedConfig {
  config: CortextPluginConfig;
  rejectedKeys: (keyof CortextPluginConfig)[];
}

/**
 * Per-field validation: a raw value is accepted ONLY if it matches the field's
 * declared type; anything else falls back to the field's DEFAULTS value and
 * the key is reported (keys only, never values). Unknown keys are ignored
 * (not rejected — they are not fields of this config). This is the boundary
 * between untrusted config sources and the config object every handler reads.
 */
const isValidValue = ({ key, value }: { key: keyof CortextPluginConfig; value: unknown }): boolean => {
  switch (key) {
    case "dbPath":
      return typeof value === "string" && value.trim().length > 0;
    case "focus":
    case "sensitivity":
    case "stability":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    case "recallLimit":
    case "protectTail":
      return typeof value === "number" && Number.isInteger(value) && value >= 0;
    case "interruptGate":
    case "ingestReasoning":
    case "autoConsolidate":
      return typeof value === "boolean";
    case "memoryScope":
      return typeof value === "string" && SCOPES.includes(value as MemoryScope);
    case "compactionMode":
      return typeof value === "string" && COMPACTION_MODES.includes(value as CompactionMode);
    default:
      return false;
  }
};

export function resolveConfig(raw: Record<string, unknown> | undefined): ResolvedConfig {
  const cfg: CortextPluginConfig = { ...DEFAULTS };
  const rejectedKeys: (keyof CortextPluginConfig)[] = [];
  if (!raw) return { config: cfg, rejectedKeys };
  for (const key of Object.keys(DEFAULTS) as (keyof CortextPluginConfig)[]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!isValidValue({ key, value })) {
      rejectedKeys.push(key);
      continue;
    }
    // dbPath is stored trimmed ("" and whitespace-only are rejected above).
    (cfg as unknown as Record<string, unknown>)[key] = key === "dbPath" ? (value as string).trim() : value;
  }
  return { config: cfg, rejectedKeys };
}
