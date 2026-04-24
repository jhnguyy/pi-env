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
 *   - extractor.ts    — session JSONL extraction for read_session tool
 *   - types.ts        — WorkTrackerConfig
 *
 * Subagent detection: if PI_AGENT_ID env var is set, context injection is skipped
 * (subagents don't need this context, and injecting it wastes tokens).
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env only)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 *   PI_SESSION_READER       — if set, keeps read_session tool active (for review subagents)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { registerCommands } from "./commands";
import { loadConfig } from "./context";
import { setSlot } from "../_shared/ui-render";
import { registerHooks } from "./hooks";
import { TodoStore } from "./store";
import { extractSession, formatSummary } from "./extractor";
import type { ExtToolRegistration } from "../subagent/types";

const SESSION_DIR = resolve(homedir(), ".pi/agent/sessions");

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
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("done"),
          Type.Literal("rm"),
          Type.Literal("list"),
          Type.Literal("clear"),
        ],
        { description: "add: create task, done: complete by id, rm: remove by id, list: show all, clear: reset" },
      ),
      text: Type.Optional(
        Type.Array(Type.String(), { description: "Task text(s) for add; task id(s) for done/rm. ALWAYS pass as a JSON array — even for a single item. Examples: add [\"my task\"], done [\"1\"], rm [\"2\"]. Ignored for list and clear." }),
      ),
    }),
    // Compatibility shim: old sessions stored text as a bare string before the
    // schema changed to Array<string> in pi-env #93. Wrap it so resumed sessions
    // don't fail schema validation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments(args: unknown): any {
      if (!args || typeof args !== "object") return args;
      const a = args as Record<string, unknown>;
      if (typeof a.text === "string") return { ...a, text: [a.text] };
      return args;
    },

    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const { action, text } = params;

      if (action === "list") {
        return { content: [{ type: "text" as const, text: store.render() }], details: {} };
      }

      if (action === "clear") {
        store.clear();
        setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
        return { content: [{ type: "text" as const, text: "Cleared all tasks." }], details: {} };
      }

      if (action === "add") {
        if (!text?.length) throw new Error("text is required for add");
        const added = text.map((t: string) => store.add(t));
        setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
        return {
          content: [{ type: "text" as const, text: added.map((i: any) => `Added: □ (${i.id}) ${i.text}`).join("\n") }],
          details: { ids: added.map((i: any) => i.id) },
        };
      }

      if (action === "done") {
        if (!text?.length) throw new Error("text is required for done");
        const completedItems: Array<{ id: number; text: string }> = [];
        const failed: string[] = [];
        for (const ref of text) {
          const n = parseInt(ref, 10);
          const item = store.complete(isNaN(n) ? ref : n);
          if (item) completedItems.push({ id: item.id, text: item.text });
          else failed.push(ref);
        }
        if (completedItems.length === 0) throw new Error(`No matching open tasks: ${failed.join(", ")}`);
        setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
        const parts: string[] = [];
        if (completedItems.length) parts.push(`Completed: ${completedItems.map(i => `✅ (${i.id}) ${i.text}`).join(", ")}`);
        if (failed.length) parts.push(`Not found: ${failed.join(", ")}`);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { ids: completedItems.map(i => i.id), failed: failed.length },
        };
      }

      if (action === "rm") {
        if (!text?.length) throw new Error("text is required for rm");
        const removedRefs: string[] = [];
        const failed: string[] = [];
        for (const ref of text) {
          const n = parseInt(ref, 10);
          const ok = store.remove(isNaN(n) ? ref : n);
          if (ok) removedRefs.push(ref);
          else failed.push(ref);
        }
        if (removedRefs.length === 0) throw new Error(`No matching tasks: ${failed.join(", ")}`);
        setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
        const parts: string[] = [];
        if (removedRefs.length) parts.push(`Removed: ${removedRefs.join(", ")}`);
        if (failed.length) parts.push(`Not found: ${failed.join(", ")}`);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { removed: removedRefs.length, failed: failed.length },
        };
      }

      throw new Error(`Unknown action: ${action}`);
    },
  });

  // ─── read_session tool ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "read_session",
    label: "Read Session",
    description:
      "Extract high-signal content from a pi session JSONL file. " +
      "Returns user prompts, agent narrative text (no raw tool outputs), " +
      "tool usage counts, and extension messages. " +
      "Use to understand what happened in a past session without parsing raw JSONL. " +
      "Discover session files with: find ~/.pi/agent/sessions/ -name '*.jsonl' | sort -r | head -20",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to a session .jsonl file under ~/.pi/agent/sessions/",
      }),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx: any) {
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Cancelled." }], details: {} };
      }

      const p = resolve(params.path.replace(/^@/, ""));

      if (!p.startsWith(SESSION_DIR + "/")) {
        throw new Error(
          `read_session is restricted to session files under ${SESSION_DIR}/. Got: ${p}`,
        );
      }

      const summary = extractSession(p);
      const raw = formatSummary(summary);

      const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = trunc.content;
      if (trunc.truncated) {
        text +=
          `\n\n[Output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}. ` +
          `Session had ${summary.userMessages.length} user turns and ${summary.agentNarrative.length} narrative blocks.]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          filename: summary.filename,
          timestamp: summary.timestamp,
          toolCounts: summary.toolCounts,
          truncated: trunc.truncated,
        },
      };
    },
  });

  // ─── Hooks ───────────────────────────────────────────────────────────────────
  registerHooks(pi, config, store);

  // ─── Agent tool registration ─────────────────────────────────────────────────
  // Register todo and read_session as AgentTools so subagents can manage tasks
  // and access past session context. UI slot updates are skipped in subagent context.
  pi.on("session_start", () => {
    const todoAgentTool: AgentTool<any, any> = {
      name: "todo",
      label: "Todo",
      description: "Manage your session task list. Actions: add, done, rm, list, clear.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("add"), Type.Literal("done"), Type.Literal("rm"), Type.Literal("list"), Type.Literal("clear")],
          { description: "add: create task, done: complete by id, rm: remove by id, list: show all, clear: reset" }),
        text: Type.Optional(Type.Array(Type.String(), { description: "Task text(s) for add; task id(s) for done/rm. ALWAYS pass as a JSON array — even for a single item. Examples: add [\"my task\"], done [\"1\"]. Ignored for list and clear." })),
      }),
      execute: async (_id, params) => {
        const { action, text } = params;
        if (action === "list") return { content: [{ type: "text", text: store.render() }], details: {} };
        if (action === "clear") { store.clear(); return { content: [{ type: "text", text: "Cleared all tasks." }], details: {} }; }
        if (action === "add") {
          if (!text?.length) throw new Error("text is required for add");
          const items = text.map((t: string) => store.add(t));
          return { content: [{ type: "text", text: items.map((i: any) => `Added: □ (${i.id}) ${i.text}`).join("\n") }], details: { ids: items.map((i: any) => i.id) } };
        }
        if (action === "done") {
          if (!text?.length) throw new Error("text is required for done");
          const completed = text.map((t: string) => { const n = parseInt(t, 10); return store.complete(isNaN(n) ? t : n); }).filter(Boolean);
          if (!completed.length) throw new Error(`No matching open tasks: ${text.join(", ")}`);
          return { content: [{ type: "text", text: completed.map((i: any) => `Completed: ✅ (${i.id}) ${i.text}`).join("\n") }], details: { ids: completed.map((i: any) => i.id) } };
        }
        if (action === "rm") {
          if (!text?.length) throw new Error("text is required for rm");
          const removed = text.filter((t: string) => { const n = parseInt(t, 10); return store.remove(isNaN(n) ? t : n); });
          if (!removed.length) throw new Error(`No matching tasks: ${text.join(", ")}`);
          return { content: [{ type: "text", text: `Removed task(s): ${removed.join(", ")}.` }], details: {} };
        }
        throw new Error(`Unknown action: ${action}`);
      },
    };
    pi.events.emit("agent-tools:register", { tool: todoAgentTool, capabilities: ["write"] } satisfies ExtToolRegistration);

    const readSessionAgentTool: AgentTool<any, any> = {
      name: "read_session",
      label: "Read Session",
      description: "Extract high-signal content from a pi session JSONL file. Returns user prompts, agent narrative, tool usage counts.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to a session .jsonl file under ~/.pi/agent/sessions/" }),
      }),
      execute: async (_id, params, signal) => {
        if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled." }], details: {} };
        const p = resolve(params.path.replace(/^@/, ""));
        if (!p.startsWith(SESSION_DIR + "/")) throw new Error(`read_session restricted to ${SESSION_DIR}/`);
        const summary = extractSession(p);
        const raw = formatSummary(summary);
        const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        return { content: [{ type: "text", text: trunc.content }], details: { filename: summary.filename, truncated: trunc.truncated } };
      },
    };
    pi.events.emit("agent-tools:register", { tool: readSessionAgentTool, capabilities: ["read"] } satisfies ExtToolRegistration);
  });
}
