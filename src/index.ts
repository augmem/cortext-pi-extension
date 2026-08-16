import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "./pi.js";
import { loadRawConfig, resolveConfig } from "./config.js";
import { CortextStore } from "./cortext.js";
import { InterruptBus } from "./store.js";
import { CortextHandlers } from "./engine.js";

/**
 * Pi extension entry point. pi loads the default export (a factory receiving
 * ExtensionAPI) via jiti.
 *
 * Registering event handlers is not a background resource — no process,
 * socket, file watcher, or timer is started here (pi's long-lived-resource
 * rule); all work happens inside the handlers, and the native engines are
 * flushed on session_shutdown.
 *
 * pi has no per-extension plugin config surface (verified against the
 * installed 0.84.2 Settings types), so config resolves as:
 *   CORTEX_PI_CONFIG env var (JSON) > ~/.pi/agent/cortext/config.json > defaults
 */
export function register(pi: ExtensionAPI): void {
  // pi's stdout is the TUI (or the RPC JSONL protocol) — diagnostics go to
  // stderr, mirroring the openclaw plugin's structured logging.
  const log = (line: string) => process.stderr.write(`cortext: ${line}\n`);
  const { config: cfg, rejectedKeys } = resolveConfig(loadRawConfig());
  if (rejectedKeys.length > 0) {
    // Keys only, never values: a config value may be sensitive or unprintable.
    log(`config rejected key(s), using defaults: ${rejectedKeys.join(", ")}`);
  }
  const bus = new InterruptBus();
  // One SQLite store per isolation scope under the pi agent dir, mirroring
  // openclaw's agent-dir layout (~/.openclaw/cortext -> ~/.pi/agent/cortext).
  const store = new CortextStore({ cfg, baseDir: join(homedir(), ".pi", "agent", "cortext") });
  const handlers = new CortextHandlers({ store, bus, log, cfg });

  pi.on("session_start", (event, ctx) => handlers.onSessionStart(event, ctx));
  pi.on("session_shutdown", (event, ctx) => handlers.onSessionShutdown(event, ctx));
  pi.on("message_start", (event, ctx) => handlers.onMessageStart(event, ctx));
  pi.on("message_update", (event, ctx) => handlers.onMessageUpdate(event, ctx));
  pi.on("message_end", (event, ctx) => handlers.onMessageEnd(event, ctx));
  pi.on("before_agent_start", (event, ctx) => handlers.onBeforeAgentStart(event, ctx));
  pi.on("context", (event, ctx) => handlers.onContext(event, ctx));
  pi.on("session_before_compact", (event, ctx) => handlers.onSessionBeforeCompact(event, ctx));

  log(
    `cortext extension active (scope=${cfg.memoryScope}, gate=${cfg.interruptGate}, ` +
    `mode=${cfg.compactionMode}, protectTail=${cfg.protectTail}, recallLimit=${cfg.recallLimit})`,
  );
}

export default function (pi: ExtensionAPI): void {
  register(pi);
}
