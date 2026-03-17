#!/usr/bin/env node
/**
 * Bun --compile entrypoint shim for pi.
 *
 * WHY THIS EXISTS
 * ---------------
 * In pi-ai@0.59.0, register-builtins.js was refactored from static imports to
 * lazy dynamic imports via a function wrapper:
 *
 *   const dynamicImport = (specifier) => import(specifier);
 *   const ANTHROPIC_PROVIDER_SPECIFIER = "./anthropic.js";
 *   // ...later: dynamicImport(ANTHROPIC_PROVIDER_SPECIFIER)
 *
 * Bun's bundler can statically trace import("./anthropic.js") with a literal
 * string, but NOT dynamicImport(ANTHROPIC_PROVIDER_SPECIFIER) through a
 * function wrapper. As a result, provider modules are excluded from the
 * compiled binary's virtual filesystem (/$bunfs/root/).
 *
 * At runtime, when a model using api: "anthropic-messages" is invoked
 * (including github-copilot models, which route through the Anthropic API),
 * the lazy loader fires:
 *   dynamicImport("./anthropic.js")  →  Error: Cannot find module './anthropic.js'
 *
 * FIX
 * ---
 * Static imports here force Bun's bundler to embed all provider files in the
 * binary. The dynamic import in register-builtins.js then resolves correctly
 * at runtime because the file is present in the bundle.
 *
 * This shim is idempotent: if pi-ai reverts to static imports in a future
 * version, these imports are harmless no-ops (same module, already bundled).
 */

// Force-include all lazy-loaded provider modules
import "@mariozechner/pi-ai/anthropic";
import "@mariozechner/pi-ai/azure-openai-responses";
import "@mariozechner/pi-ai/google";
import "@mariozechner/pi-ai/google-gemini-cli";
import "@mariozechner/pi-ai/google-vertex";
import "@mariozechner/pi-ai/mistral";
import "@mariozechner/pi-ai/openai-codex-responses";
import "@mariozechner/pi-ai/openai-completions";
import "@mariozechner/pi-ai/openai-responses";

// Run the actual CLI (sets process.title, calls main())
import "../node_modules/@mariozechner/pi-coding-agent/dist/cli.js";
