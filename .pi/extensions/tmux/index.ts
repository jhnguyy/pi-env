/**
 * Tmux Extension — entry point.
 *
 * Thin wiring only. Zero business logic. Follows the security and
 * agent-bus patterns: components are instantiated here with DI, hooks
 * and tool are registered, no conditional logic beyond the tool switch/catch.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { randomBytes } from "node:crypto";

import { TmuxClient } from "./tmux-client";
import { PaneManager } from "./pane-manager";
import type { RunDetails, TmuxConfig } from "./types";
import { DEFAULT_CONFIG, TmuxError } from "./types";

export default function (pi: ExtensionAPI) {
  // ─── Config ─────────────────────────────────────────────────
  const config: TmuxConfig = {
    ...DEFAULT_CONFIG,
    sessionPrefix: randomBytes(2).toString("hex"),  // 4-char hex
  };

  // ─── Components (DI wiring) ─────────────────────────────────
  const exec = pi.exec.bind(pi);
  const client = new TmuxClient(exec);
  const manager = new PaneManager(client, config);

  // ─── Session Lifecycle ──────────────────────────────────────
  async function rebuildRegistry(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
    manager.cleanup();
    const entries = ctx.sessionManager.getBranch();
    await manager.reconstruct(entries);
  }

  pi.on("session_start", async (_event, ctx) => rebuildRegistry(ctx));

  pi.on("session_switch", async (_event, ctx) => rebuildRegistry(ctx));
  pi.on("session_fork", async (_event, ctx) => rebuildRegistry(ctx));
  pi.on("session_tree", async (_event, ctx) => rebuildRegistry(ctx));

  pi.on("session_shutdown", async () => {
    manager.cleanup();
  });

  // ─── tmux Tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "tmux",
    label: "Tmux",
    description: [
      "Manage tmux panes for parallel subagent work and service orchestration.",
      "",
      "Actions:",
      "  run   — spawn a new pane. Required: command, label.",
      "          Optional: interactive (default false), waitOnExit (default false),",
      "          busChannel — auto-publish exit signal to this bus channel (crash-safe).",
      "          Returns: paneId (use for send/read/close).",
      "  send  — send text/commands to a running pane. Required: paneId, text.",
      "          Note: send appends Enter after text.",
      "  read  — capture current visible pane content. Required: paneId.",
      "  close — deregister pane from monitoring. Required: paneId.",
      "          Optional: kill (default false, kills the pane process).",
      "  list  — list all active panes with their IDs and labels.",
      "",
      "Pane output is NOT automatically injected. Use 'read' for debugging only (stalled panes, permission gates). Use bus wait for completion detection.",
      "For pi subagents, use: command='pi --model haiku-4 --no-session \"prompt\"'",
      "For services, use: command='uvicorn app:main --port 8000', interactive=true",
      "For interactive pi sessions: command='pi', interactive=true, then use 'send' to drive",
    ].join("\n"),

    parameters: Type.Object({
      action: StringEnum(["run", "send", "read", "close", "list"] as const, {
        description: "Operation to perform",
      }),
      // --- run params ---
      command: Type.Optional(
        Type.String({ description: "Full command to run in the pane" }),
      ),
      label: Type.Optional(
        Type.String({ description: "Short label for pane title and context output" }),
      ),
      interactive: Type.Optional(
        Type.Boolean({ description: "Whether pane accepts input (default: false)" }),
      ),
      waitOnExit: Type.Optional(
        Type.Boolean({
          description: "Show 'Press Enter to close' after exit (default: false)",
        }),
      ),
      busChannel: Type.Optional(
        Type.String({
          description: "Auto-publish exit signal to this bus channel when the pane exits (crash-safe completion signaling)",
        }),
      ),
      // --- send / read / close params ---
      paneId: Type.Optional(
        Type.String({ description: "Target pane ID (returned from run)" }),
      ),
      // --- send params ---
      text: Type.Optional(
        Type.String({ description: "Text to send to the pane" }),
      ),
      // --- close params ---
      kill: Type.Optional(
        Type.Boolean({
          description: "Kill the pane process (default: false, just deregister)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        switch (params.action) {
          case "run": {
            if (!params.command || !params.label) {
              return err("run requires command and label");
            }
            const result = await manager.run({
              action: "run",
              command: params.command,
              label: params.label,
              interactive: params.interactive,
              waitOnExit: params.waitOnExit,
              busChannel: params.busChannel,
            });
            const details: RunDetails = {
              action: "run",
              paneId: result.paneId,
              tmuxPaneId: result.tmuxPaneId,
              label: params.label,
              command: params.command,
              interactive: params.interactive ?? false,
              waitOnExit: params.waitOnExit ?? false,
              createdAt: Date.now(),
            };
            return {
              content: [txt(`Pane "${params.label}" spawned (${result.paneId}).`)],
              details,
            };
          }

          case "send": {
            if (!params.paneId || !params.text) {
              return err("send requires paneId and text");
            }
            const result = await manager.send(params.paneId, params.text);
            const msg = result.warning
              ? `Sent. Warning: ${result.warning}`
              : "Sent.";
            return {
              content: [txt(msg)],
              details: result,
            };
          }

          case "read": {
            if (!params.paneId) {
              return err("read requires paneId");
            }
            const { content, alive } = await manager.read(params.paneId);
            const prefix = alive ? "" : "[pane exited]\n";
            return {
              content: [txt(prefix + (content || "(no output)"))],
              details: { paneId: params.paneId, alive },
            };
          }

          case "close": {
            if (!params.paneId) {
              return err("close requires paneId");
            }
            const result = await manager.close(params.paneId, params.kill);
            return {
              content: [txt(`Pane ${params.paneId} closed.`)],
              details: result,
            };
          }

          case "list": {
            const panes = manager.getActivePanes();
            if (panes.length === 0) {
              return {
                content: [txt("No active panes.")],
                details: { panes: [] },
              };
            }
            const summary = panes.map(p =>
              `${p.id} "${p.label}" (${p.interactive ? "interactive" : "non-interactive"})`
            ).join("\n");
            return {
              content: [txt(summary)],
              details: { panes: panes.map(p => ({ id: p.id, label: p.label, interactive: p.interactive })) },
            };
          }

          default:
            return err(`Unknown action: ${params.action}`);
        }
      } catch (e) {
        const msg = e instanceof TmuxError
          ? `tmux error [${e.code}]: ${e.message}`
          : `unexpected error: ${e}`;
        return err(msg);
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tmux"));
      text += " " + theme.fg("accent", args.action ?? "");
      if (args.label) text += " " + theme.fg("muted", args.label);
      if (args.paneId) text += " " + theme.fg("dim", args.paneId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      const isError =
        result.details != null &&
        typeof result.details === "object" &&
        "error" in result.details;
      if (isError) {
        return new Text(theme.fg("error", text || "error"), 0, 0);
      }
      return new Text(theme.fg("success", "✓ " + text), 0, 0);
    },
  });
}

function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function err(msg: string) {
  return { content: [txt(msg)], details: { error: msg } };
}
