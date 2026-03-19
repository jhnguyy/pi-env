/**
 * OrchestratorManager — lifecycle management for multi-agent runs.
 *
 * Enforces the automation-vs-judgment boundary:
 *   - Automation (this class): ORCH_DIR, bus session, worktrees, pane spawning,
 *     cleanup, manifest writes, run receipt.
 *   - Judgment (caller/LLM): how many workers, what each builds, when to merge,
 *     whether cleanup is safe to run.
 *
 * State is in-memory. Manifest on disk is the recovery artifact.
 * One active run per manager instance (one run per pi session).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { gitSync, isGitRepo } from "../_shared/git";
import { createWorktree, prepareWorktree, removeWorktree, pruneWorktrees } from "./git";
import { writeManifest, writeReceipt } from "./manifest";
import type { OrchManifest, RunReceipt, WorkerRecord } from "./types";
import { OrchError } from "./types";
import { initBusService, getBusService } from "../agent-bus/bus-service";
import { getTmuxService } from "../tmux/tmux-service";
import { TmuxError } from "../tmux/types";
import type { BusMessage } from "../agent-bus/types";

// ─── Label validation ─────────────────────────────────────────

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateLabel(label: string): void {
  if (!LABEL_PATTERN.test(label) || label.length > 64) {
    throw new OrchError(
      `Invalid label "${label}" — use a-z, 0-9, hyphens only (max 64 chars)`,
      "INVALID_LABEL",
    );
  }
}

// ─── Pi command builder ──────────────────────────────────────
//
// Builds a `pi -e worker-bridge.ts ...` command from structured spawn params.
// Workers run in interactive mode with full TUI visible in the tmux pane.
// Sessions are persisted (no --no-session) so worker history is available for audit.
// The worker-bridge extension handles bus-driven follow-up messages and clean shutdown.
//
// Note: `--tools` filters built-in tools only (read, bash, edit, write, grep, find, ls).
// Extension tools (bus, orch, etc.) are auto-discovered regardless of this flag.

const BUILT_IN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export function buildPiCommand(opts: {
  model?: string;
  tools?: string[];
  brief?: string;
  prompt?: string;
}): string {
  // Workers run in interactive mode with the worker-bridge extension
  // for bus-driven follow-up messages and clean shutdown.
  const bridgePath = new URL("./worker-bridge.ts", import.meta.url).pathname;
  const workerMdPath = new URL("./worker.md", import.meta.url).pathname;

  const parts = [
    "pi",
    "-e", bridgePath,
    "--append-system-prompt", workerMdPath,
  ];
  if (opts.model) parts.push("--model", opts.model);
  if (opts.tools && opts.tools.length > 0) {
    const unknown = opts.tools.filter((t) => !BUILT_IN_TOOLS.has(t));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown built-in tool(s): ${unknown.join(", ")}. ` +
          `Only built-in tools are accepted: ${[...BUILT_IN_TOOLS].join(", ")}. ` +
          `Extension tools (dev-tools, bus, etc.) auto-load from ~/.pi/agent/extensions/ — no need to list them.`,
      );
    }
    parts.push("--tools", opts.tools.join(","));
  }
  if (opts.brief) parts.push(`@${opts.brief}`);
  if (opts.prompt) parts.push(JSON.stringify(opts.prompt));
  return parts.join(" ");
}

// ─── Command builder ─────────────────────────────────────────
//
// Injects PI_BUS_SESSION, PI_AGENT_ID, ORCH_DIR, and ORCH_INTERACTIVE into
// the worker environment, optionally sets cwd to the worktree.
//
// Uses `env -C <cwd>` (GNU coreutils 8.28+, standard on modern Linux)
// instead of nested `bash -c 'cd ... && ...'` to avoid shell quoting issues.

function buildWorkerCommand(opts: {
  command: string;
  busSession: string;
  orchDir: string;
  label: string;
  worktreePath?: string;
}): string {
  const { command, busSession, orchDir, label, worktreePath } = opts;

  // Escape single quotes in user command for bash -c embedding
  const safeCmd = command.replace(/'/g, "'\\''");

  // `env -C <path>` changes the working directory before exec.
  // `env <KEY=val>` injects env vars without a subshell.
  const envParts = ["env"];
  if (worktreePath) {
    envParts.push("-C", worktreePath);
  }
  envParts.push(
    `PI_BUS_SESSION=${busSession}`,
    `PI_AGENT_ID=${label}`,
    `ORCH_DIR=${orchDir}`,
    `ORCH_INTERACTIVE=1`,
  );

  return `${envParts.join(" ")} bash -c '${safeCmd}'`;
}

// ─── OrchestratorManager ─────────────────────────────────────

export class OrchestratorManager {
  private state: OrchManifest | null = null;

  constructor() {}

  // ─── start ─────────────────────────────────────────────────

  start(repo?: string): { runId: string; orchDir: string; busSession: string } {
    if (this.state) {
      throw new OrchError(
        `Orchestration already active (run ${this.state.runId}) — call orch cleanup first`,
        "RUN_ACTIVE",
      );
    }

    // Validate repo is a git repository before committing to the run
    if (repo) {
      if (!isGitRepo(repo)) {
        throw new OrchError(`Not a git repository: ${repo}`, "INVALID_REPO");
      }
    }

    const runId = randomBytes(3).toString("hex");
    const orchDir = mkdtempSync("/tmp/orch-");
    const busSession = randomBytes(3).toString("hex");

    // Initialize bus session directory via shared transport.
    // Orch owns the session lifecycle — we do NOT call client.start() here because
    // BusClient.start() caches the session ID in-memory and would conflict on restart.
    // Instead orch sets env vars directly; BusClient.getSessionId() falls back to
    // process.env.PI_BUS_SESSION when config.sessionId is null.
    const { transport } = initBusService();
    transport.ensureSession(busSession);
    // Set env so subsequent bus tool calls in this process use this session.
    process.env.PI_BUS_SESSION = busSession;
    // Set orchestrator agent ID for bus publish calls.
    process.env.PI_AGENT_ID = "orch";

    this.state = {
      runId,
      orchDir,
      busSession,
      repo,
      startedAt: Date.now(),
      workers: [],
    };

    writeManifest(orchDir, this.state);

    return { runId, orchDir, busSession };
  }

  // ─── spawn ─────────────────────────────────────────────────

  async spawn(opts: {
    label: string;
    command?: string;
    // Structured pi-spawner params — build pi command automatically when provided.
    // Mutually exclusive with `command`. At least one of command/prompt/brief required.
    model?: string;
    tools?: string[];
    brief?: string;
    prompt?: string;
    busChannel?: string;
  }): Promise<{ paneId: string; branch?: string; worktreePath?: string }> {
    if (!this.state) {
      throw new OrchError(
        "No active orchestration — call orch start first",
        "NO_ACTIVE_RUN",
      );
    }

    if (!process.env.TMUX) {
      throw new OrchError("Not running inside a tmux session", "NOT_IN_TMUX");
    }

    const { label, busChannel } = opts;

    // ─── Structured vs raw command validation ────────────────────
    const hasStructuredParams =
      opts.model !== undefined ||
      opts.tools !== undefined ||
      opts.brief !== undefined ||
      opts.prompt !== undefined;

    if (opts.command !== undefined && hasStructuredParams) {
      throw new OrchError(
        "Provide either command or structured params (model/tools/brief/prompt), not both",
        "AMBIGUOUS_SPAWN",
      );
    }

    if (opts.command === undefined && !opts.brief && !opts.prompt) {
      throw new OrchError(
        "spawn requires command, or at least one of: prompt, brief",
        "AMBIGUOUS_SPAWN",
      );
    }

    // ─── Brief file existence check ──────────────────────────────
    if (opts.brief && !existsSync(opts.brief)) {
      throw new OrchError(
        `Brief file not found: ${opts.brief}`,
        "BRIEF_NOT_FOUND",
      );
    }

    // ─── Resolve final command ────────────────────────────────────
    const command = opts.command ?? buildPiCommand({
      model: opts.model,
      tools: opts.tools,
      brief: opts.brief,
      prompt: opts.prompt,
    });
    const { runId, orchDir, busSession, repo } = this.state;

    validateLabel(label);

    // Prevent duplicate labels — catches both accidental re-use and re-spawn attempts.
    // To re-spawn a failed worker, call cleanup first or choose a new label.
    if (this.state.workers.some(w => w.label === label)) {
      throw new OrchError(
        `Worker with label "${label}" already exists in this run — use a unique label`,
        "INVALID_LABEL",
      );
    }

    // Create worktree + branch if repo is set
    let branch: string | undefined;
    let worktreePath: string | undefined;

    if (repo) {
      branch = `orch/${runId}/${label}`;
      worktreePath = `${orchDir}/${label}`;
      createWorktree(repo, worktreePath, branch);
      prepareWorktree(repo, worktreePath);

      // Install commit-msg hook for automatic Agent-Id trailer injection.
      // Workers don't need to remember — automation handles attribution.
      const hooksDir = `${worktreePath}/.git-hooks`;
      mkdirSync(hooksDir, { recursive: true });

      gitSync(worktreePath, ["config", "--local", "core.hooksPath", hooksDir]);

      const hookScript = [
        "#!/usr/bin/env bash",
        'LABEL="${PI_AGENT_ID:-}"',
        'SESSION="${PI_BUS_SESSION:-}"',
        'if [[ -n "$LABEL" || -n "$SESSION" ]]; then',
        '  printf "\\nAgent-Id: %s/%s\\n" "${LABEL:-unknown}" "${SESSION:-unknown}" >> "$1"',
        "fi",
      ].join("\n");

      writeFileSync(`${hooksDir}/commit-msg`, hookScript, { mode: 0o755 });
    }

    // Build the fully-decorated worker command
    const finalCommand = buildWorkerCommand({
      command,
      busSession,
      orchDir,
      label,
      worktreePath,
    });

    // Spawn via shared tmux PaneManager — gets grid layout + rebalancing for free.
    // PaneManager handles the exit shim (busChannel wrapping) internally.
    let paneId: string;
    let tmuxPaneId: string;
    try {
      const tmuxSvc = getTmuxService();
      const tmuxResult = await tmuxSvc.manager.run({
        action: "run",
        command: finalCommand,
        label,
        interactive: true,
        busChannel,
      });
      paneId = tmuxResult.paneId;
      tmuxPaneId = tmuxResult.tmuxPaneId;
    } catch (e) {
      if (e instanceof TmuxError) {
        throw new OrchError(
          `tmux spawn failed: ${e.message}`,
          "SPAWN_FAILED",
        );
      }
      throw e;
    }

    // Record in manifest
    const worker: WorkerRecord = {
      label,
      paneId,
      tmuxPaneId,
      branch,
      worktreePath,
      busChannel,
      spawnedAt: Date.now(),
    };

    this.state.workers.push(worker);
    writeManifest(orchDir, this.state);

    return { paneId, branch, worktreePath };
  }

  // ─── cleanup ───────────────────────────────────────────────

  async cleanup(): Promise<{
    panes: number;
    worktrees: number;
    preservedBranches: string[];
    receiptPath: string;
  }> {
    if (!this.state) {
      throw new OrchError("No active orchestration to clean up", "NO_ACTIVE_RUN");
    }

    const { runId, orchDir, busSession, repo, startedAt, workers } = this.state;
    const endedAt = Date.now();

    let panesKilled = 0;
    let worktreesRemoved = 0;
    const preservedBranches: string[] = [];

    // Kill all panes via PaneManager — best-effort (pane may already be dead)
    const tmuxSvc = getTmuxService();
    for (const worker of workers) {
      try {
        await tmuxSvc.manager.close(worker.paneId, true);
        panesKilled++;
      } catch {
        // Already dead or not found — don't block cleanup
      }
    }

    // Remove worktrees, preserve branches (orchestrator merges on its own schedule)
    if (repo) {
      for (const worker of workers) {
        if (worker.worktreePath) {
          removeWorktree(repo, worker.worktreePath);
          worktreesRemoved++;
        }
        if (worker.branch) {
          preservedBranches.push(worker.branch);
        }
      }
      pruneWorktrees(repo);
    }

    // Write run receipt before deleting orchDir — best-effort (disk full shouldn't block cleanup)
    const receipt: RunReceipt = {
      runId,
      orchDir,
      busSession,
      repo,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      workers,
      cleanedUp: { panes: panesKilled, worktrees: worktreesRemoved },
      preservedBranches,
    };
    let receiptPath = "(not written)";
    try {
      receiptPath = writeReceipt(receipt);
    } catch (err) {
      console.error(`[orch] Failed to write run receipt: ${err}`);
    }

    // Delete ORCH_DIR (manifest + any files workers wrote there)
    rmSync(orchDir, { recursive: true, force: true });

    // Delete bus session directory via transport (prevents /tmp accumulation)
    getBusService().transport.deleteSession(busSession);

    // Clear env vars set by start()
    delete process.env.PI_BUS_SESSION;
    delete process.env.PI_AGENT_ID;

    this.state = null;

    return { panes: panesKilled, worktrees: worktreesRemoved, preservedBranches, receiptPath };
  }

  // ─── wait ──────────────────────────────────────────────────

  async wait(opts: {
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<{ messages: BusMessage[]; timedOut: boolean; channels: string[] }> {
    if (!this.state) {
      throw new OrchError("No active orchestration — call orch start first", "NO_ACTIVE_RUN");
    }

    const channels = this.state.workers
      .map((w) => w.busChannel)
      .filter((ch): ch is string => ch !== undefined);

    if (channels.length === 0) {
      throw new OrchError(
        "No workers have busChannels — spawn with busChannel to use orch wait",
        "NO_BUS_CHANNELS",
      );
    }

    const { client } = getBusService();
    const { messages, timedOut } = await client.wait(channels, opts.timeout ?? 300, opts.signal);
    return { messages, timedOut, channels };
  }

  // ─── getStatus ─────────────────────────────────────────────

  getStatus(): OrchManifest | null {
    return this.state;
  }

}

