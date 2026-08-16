# Changelog

All notable changes to this project are documented here.

## [Unreleased]

- Config boundary now type-validates every field with per-field default
  fallback.
- Engine-open failure degrades the affected scope to recall-less passthrough
  with a first-failure log line; the agent keeps running.
- OTEL spans on control/failure paths via `@opentelemetry/api` (no-op
  without a collector); span attributes are bounded enums/numbers only.
- Owned multi-arg and boolean signatures converted to named-options objects.
- NOTICE rewritten for the actual npm distribution (two runtime dependencies,
  `@augmem/cortext` and `@opentelemetry/api`; no vendored third-party code).
- README documents the `fromHook` CompactionEntry field and the
  engine-open failure / telemetry behavior.
- `npm test` build-reproducibility gate (`npm run build:verify`) and a
  GitHub Actions CI workflow (typecheck, full test chain, `npm audit`).

## 0.1.0

- Initial release: port of the Cortext OpenClaw plugin to the pi coding agent
  extension surface (pi 0.84.x).
- Durable per-message ingest (`message_end`): user, assistant (tool-call args
  truncated at 2,000 chars; thinking reaches the store via the streaming gate,
  not the record), and tool results into on-device Cortext (`@augmem/cortext`).
- Live recall on every prompt (`before_agent_start` system-prompt injection)
  and on every LLM call (`context` event, hidden custom message carrying only
  memories not already injected).
- Zero-LLM-call compaction (`session_before_compact`): exchange-aligned
  `firstKeptEntryId` cut with a bridge summary; pi natively owns the kept
  window via the CompactionEntry. `hybrid` (protectTail, default) and `full`
  modes.
- Streaming interrupt gate over `message_update` text/thinking deltas;
  observe-only (pi has no finalize/revise hook) — recalled memory is staged
  for the next assembly.
- Isolation: one SQLite store per scope — `session` (default), `agent`
  (per project cwd), `global`.
- Config via `CORTEX_PI_CONFIG` env (JSON) or `~/.pi/agent/cortext/config.json`.
- Unit tests (native engine, offline) plus a live bench (`bench/live.mjs`)
  driving a real `pi --mode rpc` session in an isolated temp project.
