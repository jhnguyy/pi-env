/**
 * PaneManager — pane lifecycle management and registry.
 *
 * Creates, tracks, and removes panes. No file I/O — delegates to TmuxClient.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import type {
  CloseResult,
  ITmuxClient,
  PaneRecord,
  RunDetails,
  RunResult,
  SendResult,
  SystemPane,
  TmuxConfig,
  TmuxRunInput,
} from "./types";
import { TmuxError } from "./types";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

// ─── Bus Exit Shim ────────────────────────────────────────────
// Written lazily to /tmp on first busChannel use. Pure bash — no external deps.
// Invoked as: pi-bus-exit-shim <channel>
// Reads PI_BUS_SESSION from environment, writes atomic exit signal to bus channel dir.

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
  'FINAL="$DIR/${TS}-tmux-exit-${RAND}.json"',
  'printf \'{"channel":"%s","sender":"tmux-exit","timestamp":%s,"type":"status","message":"process exited"}\' "$CHANNEL" "$TS" > "${FINAL}.tmp" && mv "${FINAL}.tmp" "$FINAL"',
].join("\n");

function ensureExitShim(): void {
  if (existsSync(SHIM_PATH)) return;
  writeFileSync(SHIM_PATH, SHIM_SCRIPT, { mode: 0o755 });
}

// ─────────────────────────────────────────────────────────────

function makePaneRecord(opts: {
  id: string;
  tmuxPaneId: string;
  label: string;
  command: string;
  interactive?: boolean;
  waitOnExit?: boolean;
  createdAt?: number;
}): PaneRecord {
  return {
    id: opts.id,
    tmuxPaneId: opts.tmuxPaneId,
    label: opts.label,
    command: opts.command,
    interactive: opts.interactive ?? false,
    waitOnExit: opts.waitOnExit ?? false,
    createdAt: opts.createdAt ?? Date.now(),
  };
}

export class PaneManager {
  private registry: Map<string, PaneRecord> = new Map();
  /**
   * Worker panes organized by column. Column 0 = middle third, column 1 = right third.
   * Each column is an ordered list of tmux pane IDs (top to bottom).
   */
  private columns: [string[], string[]] = [[], []];

  constructor(
    private client: ITmuxClient,
    private config: TmuxConfig,
  ) {}

  // ─── run ─────────────────────────────────────────────────────

  async run(input: TmuxRunInput): Promise<RunResult> {
    if (!this.client.isInTmux()) {
      throw new TmuxError(
        "Not running inside a tmux session",
        "NOT_IN_TMUX",
      );
    }

    const id = `${this.config.sessionPrefix}-${randomBytes(2).toString("hex")}`;

    // Build command — wrap for busChannel and/or waitOnExit; otherwise pass directly.
    // All hooks appended in a single bash -c '...' to avoid double-wrapping.
    // Single quotes in user command are escaped as '\'' for safe embedding.
    let command: string;
    if (input.busChannel || input.waitOnExit) {
      const safeCmd = input.command.replace(/'/g, "'\\''");
      let suffix = "";
      if (input.busChannel) {
        ensureExitShim();
        // Shim reads PI_BUS_SESSION from env — no quoting issues (channel is validated a-z0-9:-).
        suffix += `; ${SHIM_PATH} ${input.busChannel}`;
      }
      if (input.waitOnExit) {
        suffix += `; echo; echo "  Press Enter to close..."; read`;
      }
      command = `bash -c '${safeCmd}${suffix}'`;
    } else {
      command = input.command;
    }

    // Orchestrator pane — always anchor splits to the pi process's own pane
    // so all workers land on the same window regardless of which pane the user
    // has focused or which window is active.
    const orchPaneId = process.env.TMUX_PANE ?? "";

    // Layout: orchestrator = full-height left column (1/3 width).
    // Workers fill a grid in the remaining 2/3:
    //   col0 (orch) | col1      | col2
    //   full height  | worker 0  | worker 1
    //                | worker 2  | worker 3
    //
    // Column 0 empty → split right from orch (67% to new pane)
    // Column 1 empty → split right from column 0's first pane (50% each)
    // Both columns have panes → split below the last pane in the shorter column
    let direction: "right" | "below";
    let targetPaneId: string;
    let sizePercent: number | undefined;

    if (this.columns[0].length === 0) {
      // First worker: split right from orchestrator pane
      direction = "right";
      targetPaneId = orchPaneId;
      sizePercent = 67; // new pane gets 67%, orchestrator keeps 33%
    } else if (this.columns[1].length === 0) {
      // Second worker: split right from column 0's first pane
      direction = "right";
      targetPaneId = this.columns[0][0];
      sizePercent = 50; // equal halves of the 67%
    } else {
      // Subsequent workers: split below the last pane in the shorter column
      const colIdx = this.columns[0].length <= this.columns[1].length ? 0 : 1;
      const column = this.columns[colIdx];
      direction = "below";
      targetPaneId = column[column.length - 1]; // split below the bottom pane
      sizePercent = undefined;
    }

    const tmuxPaneId = await this.client.splitWindow(direction, command, targetPaneId, sizePercent);

    // Track which column this pane belongs to
    if (direction === "right" && this.columns[0].length === 0) {
      this.columns[0].push(tmuxPaneId);
    } else if (direction === "right") {
      this.columns[1].push(tmuxPaneId);
    } else {
      // "below" split — use the target pane to find which column we split into
      if (this.columns[0].includes(targetPaneId)) {
        this.columns[0].push(tmuxPaneId);
      } else {
        this.columns[1].push(tmuxPaneId);
      }
    }

    await this.client.setupPane(tmuxPaneId, input.label);

    // Rebalance layout: enforce orch=1/3, equal worker columns, even heights
    await this.client.rebalanceLayout(orchPaneId, this.columns);

    const pane = makePaneRecord({
      id,
      tmuxPaneId,
      label: input.label,
      command: input.command,
      interactive: input.interactive,
      waitOnExit: input.waitOnExit,
    });

    this.registry.set(id, pane);

    return { paneId: id, tmuxPaneId };
  }

  // ─── send ────────────────────────────────────────────────────

  async send(paneId: string, text: string): Promise<SendResult> {
    const pane = this.registry.get(paneId);
    if (!pane) {
      throw new TmuxError(`Pane not found: ${paneId}`, "PANE_NOT_FOUND");
    }

    await this.client.sendKeys(pane.tmuxPaneId, text);

    if (!pane.interactive) {
      return { ok: true, warning: "pane is non-interactive; send may have no effect" };
    }

    return { ok: true };
  }

  // ─── read ────────────────────────────────────────────────────

  async read(paneId: string): Promise<{ content: string; alive: boolean }> {
    const pane = this.registry.get(paneId);
    if (!pane) {
      throw new TmuxError(`Pane not found: ${paneId}`, "PANE_NOT_FOUND");
    }
    // Single exec: alive inferred from capture-pane exit code (was 2 spawns).
    return this.client.capturePaneWithStatus(pane.tmuxPaneId);
  }

  // ─── close ───────────────────────────────────────────────────

  async close(paneId: string, kill?: boolean): Promise<CloseResult> {
    const pane = this.registry.get(paneId);
    if (!pane) {
      throw new TmuxError(`Pane not found: ${paneId}`, "PANE_NOT_FOUND");
    }

    this.registry.delete(paneId);
    // Remove from column tracking
    for (const col of this.columns) {
      const idx = col.indexOf(pane.tmuxPaneId);
      if (idx !== -1) {
        col.splice(idx, 1);
        break;
      }
    }

    if (kill) {
      await this.client.killPane(pane.tmuxPaneId);
      // Rebalance after killing — tmux reclaims space, but widths may drift
      const orchPaneId = process.env.TMUX_PANE ?? "";
      if (orchPaneId) {
        await this.client.rebalanceLayout(orchPaneId, this.columns);
      }
    }

    return { ok: true };
  }

  // ─── getActivePanes ─────────────────────────────────────────

  getActivePanes(): PaneRecord[] {
    return Array.from(this.registry.values());
  }

  // ─── getUnregisteredPanes ────────────────────────────────────

  /**
   * Returns system tmux panes that are not tracked in the pi registry.
   * Useful for surfacing orphaned workers from previous sessions.
   */
  async getUnregisteredPanes(): Promise<SystemPane[]> {
    const systemPanes = await this.client.listAllPanes();
    const registeredTmuxIds = new Set(
      Array.from(this.registry.values()).map((p) => p.tmuxPaneId),
    );
    // Exclude the pane pi itself is running in — it's never registered by design.
    const currentPane = process.env.TMUX_PANE;
    return systemPanes.filter(
      (p) => !registeredTmuxIds.has(p.tmuxPaneId) && p.tmuxPaneId !== currentPane,
    );
  }

  // ─── getPane ─────────────────────────────────────────────────

  getPane(paneId: string): PaneRecord | undefined {
    return this.registry.get(paneId);
  }

  // ─── getSummary ──────────────────────────────────────────────

  getSummary(): string {
    const panes = this.getActivePanes();
    if (panes.length === 0) return "";
    const parts = panes.map(
      (p) => `${p.label} (${p.tmuxPaneId}, ${p.interactive ? "interactive" : "non-interactive"})`,
    );
    return `Active panes: ${parts.join(", ")}`;
  }

  // ─── reconstruct ─────────────────────────────────────────────

  async reconstruct(sessionEntries: SessionEntry[]): Promise<void> {
    for (const entry of sessionEntries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult") continue;
      if (msg.toolName !== "tmux") continue;

      const details = msg.details as RunDetails | undefined;
      if (!details || details.action !== "run") continue;

      const { paneId, tmuxPaneId } = details;
      if (!paneId || !tmuxPaneId) continue;

      const alive = await this.client.isPaneAlive(tmuxPaneId);
      if (!alive) {
        // Best-effort reap — catches the race where the process just exited but
        // children haven't been adopted by init yet. Silently no-ops if already gone.
        await this.client.killPane(tmuxPaneId).catch(() => {});
        continue;
      }

      const pane = makePaneRecord({
        id: paneId,
        tmuxPaneId,
        label: details.label ?? paneId,
        command: details.command ?? "",
        interactive: details.interactive,
        waitOnExit: details.waitOnExit,
        createdAt: details.createdAt,
      });

      this.registry.set(paneId, pane);
    }
  }

  // ─── cleanup ─────────────────────────────────────────────────

  cleanup(): void {
    // Clear registry only. Do NOT kill panes — user may want to inspect.
    this.registry.clear();
    this.columns = [[], []];
  }
}
