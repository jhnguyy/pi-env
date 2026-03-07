/**
 * Session Todos Extension — entry point.
 *
 * Provides a lightweight in-memory task list for root agent sessions.
 * The agent adds tasks with /todo and marks them done as it works.
 * The list is injected into context before every root agent turn.
 *
 * Subagent detection: if PI_AGENT_ID env var is set, injection is skipped
 * (mirrors work-tracker pattern).
 *
 * Commands:
 *   /todo <task>       — add a task
 *   /todo done <n>     — mark task n complete (by id or partial text)
 *   /todo rm <n>       — remove a task
 *   /todo clear        — clear all tasks
 *   /todo              — show current list
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TodoStore } from "./store";

export default function (pi: ExtensionAPI) {
  const store = new TodoStore();

  function refreshWidget(ctx: ExtensionContext) {
    if (process.env.PI_AGENT_ID) return;
    ctx.ui.setWidget("session-todos", [store.render()], { placement: "belowEditor" });
  }

  // ─── 1. Clear on new session ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    store.clear();
    refreshWidget(ctx);
  });

  // ─── 2. Inject on every root turn ────────────────────────────────
  pi.on("before_agent_start", async () => {
    // Skip for subagents — PI_AGENT_ID is set by pi when spawning subagents
    if (process.env.PI_AGENT_ID) return {};

    return {
      message: {
        customType: "session-todos",
        content: store.render(),
        display: true,
      },
    };
  });

  // ─── 3. /todo command ────────────────────────────────────────────
  pi.registerCommand("todo", {
    description: [
      "Session task list. Usage:",
      "  /todo <task>       — add a task",
      "  /todo done <n>     — mark task n complete (by id or partial text)",
      "  /todo rm <n>       — remove a task",
      "  /todo clear        — clear all tasks",
      "  /todo              — show current list",
    ].join("\n"),

    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      // /todo — show list
      if (!trimmed) {
        ctx.ui.notify(store.render(), "info");
        return;
      }

      // /todo clear
      if (trimmed === "clear") {
        store.clear();
        refreshWidget(ctx);
        ctx.ui.notify("Cleared.", "info");
        return;
      }

      // /todo done <ref>
      if (trimmed.startsWith("done ")) {
        const ref = trimmed.slice(5).trim();
        const n = parseInt(ref, 10);
        const item = store.complete(isNaN(n) ? ref : n);
        if (item) {
          refreshWidget(ctx);
          ctx.ui.notify(`✅ (${item.id}) ${item.text}`, "info");
        } else {
          ctx.ui.notify(`No matching task: ${ref}`, "warning");
        }
        return;
      }

      // /todo rm <ref>
      if (trimmed.startsWith("rm ")) {
        const ref = trimmed.slice(3).trim();
        const n = parseInt(ref, 10);
        const ok = store.remove(isNaN(n) ? ref : n);
        if (ok) {
          refreshWidget(ctx);
          ctx.ui.notify("Removed.", "info");
        } else {
          ctx.ui.notify(`No matching task: ${ref}`, "warning");
        }
        return;
      }

      // /todo <task> — add
      const item = store.add(trimmed);
      refreshWidget(ctx);
      ctx.ui.notify(`□ (${item.id}) ${item.text}`, "info");
    },
  });
}
