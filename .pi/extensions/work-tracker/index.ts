/**
 * Work Tracker Extension — entry point.
 *
 * Thin wiring only. Business logic lives in:
 *   - context.ts      — git status helpers, widget refresh, config loading
 *   - commands.ts     — /review-retros, /handoff command registrations
 *   - hooks.ts        — tool_call/result + session_start + before_agent_start hooks
 *   - branch-guard.ts — BranchGuard class (protected branch enforcement)
 *   - handoff-cleanup — handoff file cleanup on branch merge
 *   - store.ts        — TodoStore (in-memory task list)
 *   - todo-tool.ts    — todo schema, enum, and execution logic
 *   - types.ts        — WorkTrackerConfig
 *
 * Subagent detection: if PI_AGENT_ID env var is set, context injection is skipped
 * (subagents don't need this context, and injecting it wastes tokens).
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env only)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import { registerCommands } from "./commands";
import { loadConfig } from "./context";
import { registerHooks } from "./hooks";
import { TodoStore } from "./store";
import { TODO_PARAMETERS, executeTodo, prepareTodoArguments, type TodoParams } from "./todo-tool";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const store = new TodoStore();

  // ─── Commands ────────────────────────────────────────────────────────────────
  registerCommands(pi);

  // ─── todo tool ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage your session task list. Use to track multi-step plans, mark progress, " +
      "and keep yourself organized across turns. The list is visible in context every turn.",
    parameters: TODO_PARAMETERS,
    // Compatibility shim: old sessions stored text as a bare string before the
    // schema changed to Array<string> in pi-env #93. Wrap it so resumed sessions
    // don't fail schema validation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments(args: unknown): any {
      return prepareTodoArguments(args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeTodo(store, params as TodoParams, ctx, pi);
    },
  });

  // ─── Hooks ───────────────────────────────────────────────────────────────────
  registerHooks(pi, config, store);

  // ─── Agent tool registration ─────────────────────────────────────────────────
  // Register todo as an AgentTool so subagents can manage tasks.
  // UI slot updates are skipped in subagent context.
  pi.on(PiEvent.SessionStart, () => {
    const todoAgentTool: AgentTool<any, any> = {
      name: "todo",
      label: "Todo",
      description: "Manage your session task list. Actions: add, done, rm, list, clear.",
      parameters: TODO_PARAMETERS,
      execute: async (_id, params) => executeTodo(store, params as TodoParams),
    };
    registerAgentTools(pi, { tool: todoAgentTool, capabilities: [ToolCapability.Write] });
  });
}
