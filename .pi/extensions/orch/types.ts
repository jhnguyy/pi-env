/**
 * Shared types for the orch extension.
 */

// ─── Worker Record ────────────────────────────────────────────

export interface WorkerRecord {
  label: string;
  paneId: string;        // internal ID: orch-<runId>-<label>
  tmuxPaneId: string;    // tmux native: %0, %1, etc.
  branch?: string;       // git branch if worktree was created
  worktreePath?: string; // absolute path to worktree
  busChannel?: string;   // bus channel for completion signaling
  spawnedAt: number;
}

// ─── Manifest (written to ORCH_DIR/.manifest.json) ───────────

export interface OrchManifest {
  runId: string;
  orchDir: string;
  busSession: string;
  repo?: string;         // git repo root if branch isolation is active
  startedAt: number;
  workers: WorkerRecord[];
}

// ─── Run Receipt (written to /tmp/orch-runs/ on cleanup) ─────
//
// Stable after the run ends — used for retrospectives.
// Reveals whether workers published signals, how many were spawned,
// and which branches to review before deleting.

export interface RunReceipt {
  runId: string;
  orchDir: string;      // path that was cleaned up
  busSession: string;
  repo?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  workers: WorkerRecord[];
  cleanedUp: {
    panes: number;
    worktrees: number;
  };
  // Branches preserved after cleanup — orchestrator merges or discards
  preservedBranches: string[];
}

// ─── Error ───────────────────────────────────────────────────

export type OrchErrorCode =
  | "RUN_ACTIVE"
  | "NO_ACTIVE_RUN"
  | "NOT_IN_TMUX"
  | "INVALID_REPO"
  | "WORKTREE_CREATE_FAILED"
  | "SPAWN_FAILED"
  | "INVALID_LABEL"
  | "NO_BUS_CHANNELS";

export class OrchError extends Error {
  constructor(
    message: string,
    public code: OrchErrorCode,
  ) {
    super(message);
    this.name = "OrchError";
  }
}

// ─── ExecFn (matches pi.exec signature) ──────────────────────

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
