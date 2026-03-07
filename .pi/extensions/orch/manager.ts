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

import { createWorktree, removeWorktree, pruneWorktrees } from "./git";
import { writeManifest, writeReceipt } from "./manifest";
import type { ExecFn, OrchManifest, RunReceipt, WorkerRecord } from "./types";
import { OrchError } from "./types";

// ─── Bus exit shim ────────────────────────────────────────────
// Mirrors pane-manager.ts — duplicated intentionally to keep orch self-contained.

const SHIM_PATH = "/tmp/pi-bus-exit-shim";

const SHIM_SCRIPT = [
  "#!/usr/bin/env bash",
  'CHANNEL="$1"',
  'SESSION="${PI_BUS_SESSION:-}"',
  '[ -n "$SESSION" ] || exit 0',
  'DIR="/tmp/pi-bus-${SESSION}/channels/${CHANNEL}"',
  'mkdir -p "$DIR" 2>/dev/null',
  'TS=$(date +%s)000',
  'RAND=$(od -An -N2 -tx1 /dev/urandom 2>/dev/null | tr -dc a-f0-9 | head -c4 || printf "%04x" 0)',
  'FINAL="$DIR/${TS}-orch-exit-${RAND}.json"',
  'printf \'{"channel":"%s","sender":"orch-exit","timestamp":%s,"type":"status","message":"process exited"}\' "$CHANNEL" "$TS" > "${FINAL}.tmp" && mv "${FINAL}.tmp" "$FINAL"',
].join("\n");

function ensureExitShim(): void {
  if (existsSync(SHIM_PATH)) return;
  writeFileSync(SHIM_PATH, SHIM_SCRIPT, { mode: 0o755 });
}

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

// ─── Command builder ─────────────────────────────────────────
//
// Injects PI_BUS_SESSION + PI_AGENT_ID into the worker environment,
// optionally sets cwd to the worktree, and appends the bus exit shim.
//
// Uses `env -C <cwd>` (GNU coreutils 8.28+, standard on modern Linux)
// instead of nested `bash -c 'cd ... && ...'` to avoid shell quoting issues.

function buildWorkerCommand(opts: {
  command: string;
  busSession: string;
  label: string;
  worktreePath?: string;
  busChannel?: string;
}): string {
  const { command, busSession, label, worktreePath, busChannel } = opts;

  // Escape single quotes in user command for bash -c embedding
  const safeCmd = command.replace(/'/g, "'\\''");

  // Build suffix for bus exit shim (crash-safe completion signaling)
  let suffix = "";
  if (busChannel) {
    ensureExitShim();
    suffix = `; ${SHIM_PATH} ${busChannel}`;
  }

  // `env -C <path>` changes the working directory before exec.
  // `env <KEY=val>` injects env vars without a subshell.
  const envParts = ["env"];
  if (worktreePath) {
    envParts.push("-C", worktreePath);
  }
  envParts.push(`PI_BUS_SESSION=${busSession}`, `PI_AGENT_ID=${label}`);

  return `${envParts.join(" ")} bash -c '${safeCmd}${suffix}'`;
}

// ─── OrchestratorManager ─────────────────────────────────────

export class OrchestratorManager {
  private state: OrchManifest | null = null;

  constructor(private execFn: ExecFn) {}

  // ─── start ─────────────────────────────────────────────────

  start(repo?: string): { runId: string; orchDir: string; busSession: string } {
    if (this.state) {
      throw new OrchError(
        `Orchestration already active (run ${this.state.runId}) — call orch cleanup first`,
        "RUN_ACTIVE",
      );
    }

    const runId = randomBytes(3).toString("hex");
    const orchDir = mkdtempSync("/tmp/orch-");
    const busSession = randomBytes(3).toString("hex");

    // Initialize bus session directory so `bus wait` calls work immediately
    mkdirSync(`/tmp/pi-bus-${busSession}`, { recursive: true });
    // Set env so subsequent bus tool calls in this process use this session
    process.env.PI_BUS_SESSION = busSession;
    // Set orchestrator agent ID for bus publish calls
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
    command: string;
    interactive?: boolean;
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

    const { label, command, interactive = true, busChannel } = opts;
    const { runId, orchDir, busSession, repo } = this.state;

    validateLabel(label);

    // Create worktree + branch if repo is set
    let branch: string | undefined;
    let worktreePath: string | undefined;

    if (repo) {
      branch = `orch/${runId}/${label}`;
      worktreePath = `${orchDir}/${label}`;
      createWorktree(repo, worktreePath, branch);
    }

    // Build the fully-decorated worker command
    const finalCommand = buildWorkerCommand({
      command,
      busSession,
      label,
      worktreePath,
      busChannel,
    });

    // Spawn tmux pane
    const tmuxPaneId = await this.spawnTmuxPane(finalCommand, label, interactive);
    const paneId = `orch-${runId}-${label}`;

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

    // Kill all panes — best-effort (pane may already be dead)
    for (const worker of workers) {
      try {
        const result = await this.execFn("tmux", ["kill-pane", "-t", worker.tmuxPaneId]);
        if (result.code === 0) panesKilled++;
      } catch {
        // Already dead — don't block cleanup
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

    // Write run receipt before deleting orchDir
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
    const receiptPath = writeReceipt(receipt);

    // Delete ORCH_DIR (manifest + any files workers wrote there)
    rmSync(orchDir, { recursive: true, force: true });

    // Clear env vars set by start()
    delete process.env.PI_BUS_SESSION;
    delete process.env.PI_AGENT_ID;

    this.state = null;

    return { panes: panesKilled, worktrees: worktreesRemoved, preservedBranches, receiptPath };
  }

  // ─── getStatus ─────────────────────────────────────────────

  getStatus(): OrchManifest | null {
    return this.state;
  }

  // ─── Private: spawn tmux pane ──────────────────────────────

  private async spawnTmuxPane(
    command: string,
    label: string,
    _interactive: boolean,
  ): Promise<string> {
    // Split horizontally: new pane to the right of current
    const result = await this.execFn("tmux", [
      "split-window",
      "-h",   // horizontal split
      "-d",   // don't switch to new pane
      "-P",   // print pane ID on stdout
      "-F", "#{pane_id}",
      command,
    ]);

    if (result.code !== 0) {
      throw new OrchError(
        `tmux split-window failed: ${(result.stderr || result.stdout || "").trim()}`,
        "SPAWN_FAILED",
      );
    }

    const tmuxPaneId = result.stdout.trim();

    // Set pane title — best-effort cosmetic
    await this.execFn("tmux", [
      "select-pane", "-t", tmuxPaneId, "-T", label,
    ]).catch(() => {});

    return tmuxPaneId;
  }
}
