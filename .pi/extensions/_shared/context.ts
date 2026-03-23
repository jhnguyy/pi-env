/**
 * context.ts — shared session-context helpers for pi-env extensions.
 *
 * @purpose Two distinct "am I a subagent?" questions arise across extensions:
 *
 *   1. isHeadless(ctx)  — "should I render UI widgets / status bar entries?"
 *      True when ctx.hasUI is false (RPC mode, print mode, in-process
 *      agentLoop subagents). Safe for all rendering guards.
 *
 *   2. isOrchWorker()   — "should I skip injecting context into LLM messages?"
 *      True when PI_ORCH_WORKER is set, meaning this process was spawned as
 *      an orch worker pane. Distinct from PI_AGENT_ID, which is also set on
 *      the parent orchestrator process by orch.start() for bus identification.
 *      Never use PI_AGENT_ID for this check — it poisons the parent session.
 *
 * Do NOT use process.env.PI_AGENT_ID as a subagent guard. orch.start() sets
 * it on the parent process for bus purposes and orch.cleanup() removes it,
 * meaning any /reload or session event during an active orchestration run will
 * break all widget rendering in the main session.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Returns true when the current process has no interactive TUI.
 * Use this to gate widget / status bar rendering.
 */
export function isHeadless(ctx: ExtensionContext): boolean {
  return !ctx.hasUI;
}

/**
 * Returns true when this process was spawned as an orch worker pane.
 * Use this to skip LLM context injection (git status, todos, etc.) in
 * worker sessions that don't need them.
 */
export function isOrchWorker(): boolean {
  return !!process.env.PI_ORCH_WORKER;
}
