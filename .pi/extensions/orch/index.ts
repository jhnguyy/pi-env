/**
 * Orch Extension — entry point.
 *
 * Thin wiring only. Zero business logic. All state and lifecycle management
 * lives in OrchestratorManager.
 *
 * Automation-vs-judgment boundary:
 *   - Orch handles: ORCH_DIR creation, bus session init, worktree + branch
 *     isolation per worker, pane spawning with env injection, cleanup,
 *     manifest writes, run receipts for retrospectives.
 *   - LLM handles: decomposition, worker scope, when synthesis is complete,
 *     merge strategy for preserved branches.
 *
 * One active run per session. `orch cleanup` must be called before `orch start`
 * can be called again. On session_shutdown, logs uncleaned runs — visible in
 * the TUI for retrospective review.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import { OrchestratorManager } from "./manager";
import { cleanupOrphanedOrchDirs } from "./manifest";
import { txt, ok, err } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { defaultRenderResult } from "../_shared/render";

export default function (pi: ExtensionAPI) {
  const manager = new OrchestratorManager();

  // ─── session_shutdown hook ───────────────────────────────────
  //
  // If the session ends without orch cleanup, log the uncleaned run.
  // This surfaces in the TUI and the retro — making the miss visible
  // rather than silently letting orphaned panes and worktrees accumulate.

  pi.on("session_shutdown", async () => {
    const status = manager.getStatus();
    if (status) {
      console.error(
        `[orch] WARNING: session ended with active run ${status.runId} — ` +
        `${status.workers.length} workers were not cleaned up. ` +
        `Branches: ${status.workers.map(w => w.branch).filter(Boolean).join(", ") || "none"}. ` +
        `ORCH_DIR: ${status.orchDir} (may still exist on disk).`,
      );
    }
    // Best-effort cleanup of orphaned orch dirs from crashed runs
    cleanupOrphanedOrchDirs(status?.orchDir);
  });

  // ─── orch tool ───────────────────────────────────────────────

  pi.registerTool({
    name: "orch",
    label: "Orch",

    description: [
      "Orchestration lifecycle manager — enforces branch isolation, temp dir cleanup, and run receipts.",
      "",
      "Actions:",
      "  start   — Begin a new orchestration run. Creates ORCH_DIR (/tmp/orch-*), initializes bus",
      "            session, sets PI_BUS_SESSION for this process. Optional: repo path enables",
      "            git worktree isolation per worker (separate branch per pane, no commits collide).",
      "            Returns: runId, orchDir, busSession.",
      "",
      "  spawn   — Spawn one worker pane. Required: label (a-z, 0-9, hyphens).",
      "            Two modes:",
      "            • Raw: provide command (full shell command string).",
      "            • Pi spawner: provide model/tools/brief/prompt — orch builds the pi command.",
      "              Workers run in full interactive mode (streaming TUI visible in tmux pane).",
      "              model: model ID (e.g. 'claude-sonnet-4-6')",
      "              tools: built-in tool whitelist (e.g. ['read','bash']). Bus always auto-loaded.",
      "              brief: path to brief file (injected as @file into pi prompt).",
      "              prompt: inline prompt string for the worker.",
      "            Follow-up messages: publish to worker:<label>:inbox via bus.",
      "            Workers write results to $ORCH_DIR/<label>.json.",
      "            Cannot mix command and pi-spawner params. Need command OR prompt/brief.",
      "            Automatically injects PI_BUS_SESSION, PI_AGENT_ID, and ORCH_DIR into worker env.",
      "            Workers can write output to $ORCH_DIR/<label>.json — orchestrator reads from there.",
      "            If repo was set on start: creates worktree at ORCH_DIR/<label> on branch",
      "            orch/<runId>/<label>. Worker starts in that directory — no manual cd needed.",
      "            Optional: busChannel — crash-safe exit signal (same as tmux busChannel).",
      "            Returns: paneId, branch (if worktree), worktreePath (if worktree).",
      "",
      "  cleanup — Kill all panes, remove all worktrees, delete ORCH_DIR.",
      "            Branches are preserved — merge or discard them before calling cleanup,",
      "            or after (they're listed in the receipt). Writes a run receipt to",
      "            /tmp/orch-runs/<ts>-<runId>.json for retrospective review.",
      "            Required: call this after synthesis is complete.",
      "",
      "  status  — Show current run state: runId, workers, orchDir, busSession.",
      "            Returns 'no active run' if orch start has not been called.",
      "",
      "  wait    — Block until any spawned worker's busChannel receives a message.",
      "            No arguments required — orch already knows the channels from spawn.",
      "            Optional: timeout (seconds, default 300).",
      "            Requires at least one worker spawned with busChannel.",
      "",
      "Typical flow:",
      "  orch start { repo } → orch spawn × N → orch wait → read results → orch cleanup",
      "",
      "Branch isolation: each worker gets orch/<runId>/<label>. Two workers cannot commit",
      "to the same branch. After cleanup, run: git branch --list 'orch/*' to see preserved work.",
      "",
      "Retrospectives: ls /tmp/orch-runs/ — each file is a structured run receipt.",
    ].join("\n"),

    parameters: Type.Object({
      action: StringEnum(["start", "spawn", "cleanup", "status", "wait"] as const, {
        description: "Operation to perform",
      }),
      // start params
      repo: Type.Optional(
        Type.String({
          description:
            "Absolute path to git repo root. Enables worktree isolation — each worker gets " +
            "its own branch. Omit for scout-only or non-code runs.",
        }),
      ),
      // spawn params
      label: Type.Optional(
        Type.String({
          description:
            "Worker label — a-z, 0-9, hyphens only, max 64 chars. " +
            "Used as pane title, PI_AGENT_ID, and branch suffix.",
        }),
      ),
      command: Type.Optional(
        Type.String({ description: "Full command to run in the worker pane. Mutually exclusive with pi-spawner params." }),
      ),
      // Pi spawner params — build pi command automatically
      model: Type.Optional(
        Type.String({
          description: "Model for the worker (e.g. 'claude-sonnet-4-6'). Pi spawner mode only.",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Built-in tool whitelist for the worker (e.g. ['read','bash']). Only built-in tools: read, bash, edit, write, grep, find, ls. Extension tools (dev-tools, bus, etc.) auto-load — do not list them here. Pi spawner mode only.",
        }),
      ),
      brief: Type.Optional(
        Type.String({
          description: "Absolute path to brief file. Injected as @file into the pi prompt. Must exist. Pi spawner mode only.",
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          description: "Inline prompt string for the worker. Pi spawner mode only.",
        }),
      ),
      busChannel: Type.Optional(
        Type.String({
          description:
            "Auto-publish exit signal to this bus channel when the worker exits (crash-safe).",
        }),
      ),
      // wait params
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds for orch wait (default: 300).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal) {
      try {
        switch (params.action) {
          case "start": {
            const result = manager.start(params.repo);
            const repoNote = params.repo
              ? `\nRepo: ${params.repo} (worktree isolation active)`
              : "\nNo repo — scout/note-only run";
            return ok(
              `Run ${result.runId} started.\n` +
              `ORCH_DIR: ${result.orchDir}\n` +
              `Bus session: ${result.busSession} (PI_BUS_SESSION set)` +
              repoNote,
            );
          }

          case "spawn": {
            if (!params.label) {
              return err("spawn requires label");
            }
            const result = await manager.spawn({
              label: params.label,
              command: params.command,
              model: params.model,
              tools: params.tools,
              brief: params.brief,
              prompt: params.prompt,
              busChannel: params.busChannel,
            });
            const lines = [`Worker '${params.label}' spawned.`, `Pane: ${result.paneId}`];
            if (result.branch) lines.push(`Branch: ${result.branch}`);
            if (result.worktreePath) lines.push(`Worktree: ${result.worktreePath}`);
            if (params.busChannel) lines.push(`Bus channel: ${params.busChannel}`);
            return ok(lines.join("\n"));
          }

          case "cleanup": {
            const result = await manager.cleanup();
            const lines = [
              "Cleanup complete.",
              `Panes killed: ${result.panes}`,
              `Worktrees removed: ${result.worktrees}`,
            ];
            if (result.preservedBranches.length > 0) {
              lines.push(`Preserved branches: ${result.preservedBranches.join(", ")}`);
              lines.push("Review and merge or delete them before the next run.");
            }
            lines.push(`Receipt: ${result.receiptPath}`);
            return ok(lines.join("\n"));
          }

          case "status": {
            const state = manager.getStatus();
            if (!state) {
              return ok("No active run. Call orch start to begin.");
            }
            const lines = [
              `Run ${state.runId} active since ${new Date(state.startedAt).toISOString()}`,
              `ORCH_DIR: ${state.orchDir}`,
              `Bus session: ${state.busSession}`,
            ];
            if (state.repo) lines.push(`Repo: ${state.repo}`);
            if (state.workers.length === 0) {
              lines.push("Workers: none spawned yet");
            } else {
              lines.push(`Workers (${state.workers.length}):`);
              for (const w of state.workers) {
                const parts = [`  ${w.label} — pane ${w.tmuxPaneId}`];
                if (w.branch) parts.push(`branch: ${w.branch}`);
                lines.push(parts.join(", "));
              }
            }
            return ok(lines.join("\n"));
          }

          case "wait": {
            const result = await manager.wait({
              timeout: params.timeout,
              signal: _signal ?? undefined,
            });
            if (result.timedOut) {
              const list = result.channels.map((ch) => `#${ch}`).join(", ");
              return ok(`Timeout (${params.timeout ?? 300}s) — no messages on ${list}`);
            }
            const formatted = result.messages
              .map((m) => {
                const time = new Date(m.timestamp).toTimeString().slice(0, 8);
                let line = `[${m.sender} ${time}] ${m.message}`;
                if (m.data && Object.keys(m.data).length > 0) {
                  line += ` ${JSON.stringify(m.data)}`;
                }
                return line;
              })
              .join("\n");
            return ok(formatted);
          }

          default:
            return err(`Unknown action: ${params.action}`);
        }
      } catch (e) {
        return err(formatError(e, "orch"));
      }
    },

    renderCall(args, theme, _ctx) {
      let text = theme.fg("toolTitle", theme.bold("orch"));
      text += " " + theme.fg("accent", args.action ?? "");
      if (args.label) text += " " + theme.fg("muted", args.label);
      if (args.repo) text += " " + theme.fg("dim", args.repo.split("/").pop() ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _ctx) {
      return defaultRenderResult(result, theme, { truncateToFirstLine: true });
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────
// txt / ok / err imported from ../_shared/result
// defaultRenderResult imported from ../_shared/render
