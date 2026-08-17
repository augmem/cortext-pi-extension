#!/usr/bin/env node
/**
 * Pre-warm the on-device Cortext model cache.
 *
 * The native engine (@augmem/cortext) downloads a pinned, sha256-verified
 * AIST GGUF model (141 MB) plus tokenizer from Hugging Face on first engine
 * creation; until then engine creation fails and the extension degrades the
 * scope (documented behavior). Fresh CI runners have no cache, so CI runs
 * this before the test chain and caches the result — the download happens
 * once per pinned model revision. Locally it is the explicit form of the
 * one-time model download ("fully offline after a one-time model download").
 *
 * Idempotent: verified files (size + sha256) are skipped. No args.
 * Env override: CORTEXT_MODEL_CACHE_DIR (engine-defined).
 */
import { ensureDefaultAssets, modelCacheDir } from "@augmem/cortext";

const cacheDir = modelCacheDir();
console.log(`cortext model cache: ${cacheDir}`);
await ensureDefaultAssets();
console.log("model + tokenizer cached (sha256-verified) — engine is offline from here on");
