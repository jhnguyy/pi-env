#!/usr/bin/env node
/**
 * Patch pi-ai's register-builtins.js to use static imports before bun --compile.
 *
 * WHY: pi-ai@0.59.0 refactored all provider loading to lazy dynamic imports:
 *   const dynamicImport = (specifier) => import(specifier);
 *   dynamicImport("./anthropic.js")   // Bun can't statically trace this
 *
 * Bun's --compile bundler cannot follow dynamic imports through a function
 * wrapper, so provider files are excluded from the compiled binary. At runtime:
 *   Error: Cannot find module './anthropic.js' from '/$bunfs/root/...'
 *
 * This script rewrites register-builtins.js to use static imports (like the
 * 0.58.4 version did), while preserving the 0.59.0 export surface (the
 * re-exported stream* functions).
 *
 * The patched file is written to a backup location so the original can be
 * restored after compilation. Idempotent — safe to run multiple times.
 *
 * Usage: node setup/patch-register-builtins.js <pi-ai-dir> [--restore]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { join } from "path";

const piAiDir = process.argv[2];
const restore = process.argv.includes("--restore");

if (!piAiDir) {
  console.error("Usage: node patch-register-builtins.js <pi-ai-dir> [--restore]");
  process.exit(1);
}

const target = join(piAiDir, "dist/providers/register-builtins.js");
const backup = target + ".bak";

if (restore) {
  if (existsSync(backup)) {
    copyFileSync(backup, target);
    console.log("  ✓  Restored original register-builtins.js");
  }
  process.exit(0);
}

// Back up original
copyFileSync(target, backup);

// Write patched version with static imports
const patched = `\
import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { streamAnthropic as _streamAnthropic, streamSimpleAnthropic as _streamSimpleAnthropic } from "./anthropic.js";
import { streamAzureOpenAIResponses as _streamAzureOpenAIResponses, streamSimpleAzureOpenAIResponses as _streamSimpleAzureOpenAIResponses } from "./azure-openai-responses.js";
import { streamGoogle as _streamGoogle, streamSimpleGoogle as _streamSimpleGoogle } from "./google.js";
import { streamGoogleGeminiCli as _streamGoogleGeminiCli, streamSimpleGoogleGeminiCli as _streamSimpleGoogleGeminiCli } from "./google-gemini-cli.js";
import { streamGoogleVertex as _streamGoogleVertex, streamSimpleGoogleVertex as _streamSimpleGoogleVertex } from "./google-vertex.js";
import { streamMistral as _streamMistral, streamSimpleMistral as _streamSimpleMistral } from "./mistral.js";
import { streamOpenAICodexResponses as _streamOpenAICodexResponses, streamSimpleOpenAICodexResponses as _streamSimpleOpenAICodexResponses } from "./openai-codex-responses.js";
import { streamOpenAICompletions as _streamOpenAICompletions, streamSimpleOpenAICompletions as _streamSimpleOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses as _streamOpenAIResponses, streamSimpleOpenAIResponses as _streamSimpleOpenAIResponses } from "./openai-responses.js";

// Re-export stream functions (added in 0.59.0)
export const streamAnthropic = _streamAnthropic;
export const streamSimpleAnthropic = _streamSimpleAnthropic;
export const streamAzureOpenAIResponses = _streamAzureOpenAIResponses;
export const streamSimpleAzureOpenAIResponses = _streamSimpleAzureOpenAIResponses;
export const streamGoogle = _streamGoogle;
export const streamSimpleGoogle = _streamSimpleGoogle;
export const streamGoogleGeminiCli = _streamGoogleGeminiCli;
export const streamSimpleGoogleGeminiCli = _streamSimpleGoogleGeminiCli;
export const streamGoogleVertex = _streamGoogleVertex;
export const streamSimpleGoogleVertex = _streamSimpleGoogleVertex;
export const streamMistral = _streamMistral;
export const streamSimpleMistral = _streamSimpleMistral;
export const streamOpenAICodexResponses = _streamOpenAICodexResponses;
export const streamSimpleOpenAICodexResponses = _streamSimpleOpenAICodexResponses;
export const streamOpenAICompletions = _streamOpenAICompletions;
export const streamSimpleOpenAICompletions = _streamSimpleOpenAICompletions;
export const streamOpenAIResponses = _streamOpenAIResponses;
export const streamSimpleOpenAIResponses = _streamSimpleOpenAIResponses;

// Bedrock: keep lazy-loaded via setBedrockProviderModule (cli.js injects it)
const dynamicImport = (specifier) => import(specifier);
const BEDROCK_PROVIDER_SPECIFIER = "./amazon-" + "bedrock.js";
let bedrockProviderModuleOverride;

export function setBedrockProviderModule(module) {
    bedrockProviderModuleOverride = {
        stream: module.streamBedrock,
        streamSimple: module.streamSimpleBedrock,
    };
}

function forwardStream(target, source) {
    (async () => {
        for await (const event of source) {
            target.push(event);
        }
        target.end();
    })();
}

function createLazyLoadErrorMessage(model, error) {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}

let bedrockProviderModulePromise;
function loadBedrockProviderModule() {
    if (bedrockProviderModuleOverride) {
        return Promise.resolve(bedrockProviderModuleOverride);
    }
    bedrockProviderModulePromise ||= dynamicImport(BEDROCK_PROVIDER_SPECIFIER).then((module) => {
        return { stream: module.streamBedrock, streamSimple: module.streamSimpleBedrock };
    });
    return bedrockProviderModulePromise;
}

function createLazyStream(loadModule) {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();
        loadModule()
            .then((module) => {
                const inner = module.stream(model, context, options);
                forwardStream(outer, inner);
            })
            .catch((error) => {
                const message = createLazyLoadErrorMessage(model, error);
                outer.push({ type: "error", reason: "error", error: message });
                outer.end(message);
            });
        return outer;
    };
}

function createLazySimpleStream(loadModule) {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();
        loadModule()
            .then((module) => {
                const inner = module.streamSimple(model, context, options);
                forwardStream(outer, inner);
            })
            .catch((error) => {
                const message = createLazyLoadErrorMessage(model, error);
                outer.push({ type: "error", reason: "error", error: message });
                outer.end(message);
            });
        return outer;
    };
}

const streamBedrockLazy = createLazyStream(loadBedrockProviderModule);
const streamSimpleBedrockLazy = createLazySimpleStream(loadBedrockProviderModule);

export function registerBuiltInApiProviders() {
    registerApiProvider({ api: "anthropic-messages", stream: _streamAnthropic, streamSimple: _streamSimpleAnthropic });
    registerApiProvider({ api: "openai-completions", stream: _streamOpenAICompletions, streamSimple: _streamSimpleOpenAICompletions });
    registerApiProvider({ api: "mistral-conversations", stream: _streamMistral, streamSimple: _streamSimpleMistral });
    registerApiProvider({ api: "openai-responses", stream: _streamOpenAIResponses, streamSimple: _streamSimpleOpenAIResponses });
    registerApiProvider({ api: "azure-openai-responses", stream: _streamAzureOpenAIResponses, streamSimple: _streamSimpleAzureOpenAIResponses });
    registerApiProvider({ api: "openai-codex-responses", stream: _streamOpenAICodexResponses, streamSimple: _streamSimpleOpenAICodexResponses });
    registerApiProvider({ api: "google-generative-ai", stream: _streamGoogle, streamSimple: _streamSimpleGoogle });
    registerApiProvider({ api: "google-gemini-cli", stream: _streamGoogleGeminiCli, streamSimple: _streamSimpleGoogleGeminiCli });
    registerApiProvider({ api: "google-vertex", stream: _streamGoogleVertex, streamSimple: _streamSimpleGoogleVertex });
    registerApiProvider({ api: "bedrock-converse-stream", stream: streamBedrockLazy, streamSimple: streamSimpleBedrockLazy });
}

export function resetApiProviders() {
    clearApiProviders();
    registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
`;

writeFileSync(target, patched);
console.log("  ✓  Patched register-builtins.js (static imports for bun --compile)");
