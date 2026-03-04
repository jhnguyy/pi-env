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

    // Always split right — rebalanceLayout will arrange all panes evenly.
    const tmuxPaneId = await this.client.splitWindow("right", command);

    // Set pane title + rebalance layout in one exec (was 3 separate spawns).
    await this.client.setupPane(tmuxPaneId, input.label);

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

    if (kill) {
      // Kill + rebalance in one exec (was 3 separate spawns).
      await this.client.killPaneAndRebalance(pane.tmuxPaneId);
    }

    return { ok: true };
  }

  // ─── getActivePanes ─────────────────────────────────────────

  getActivePanes(): PaneRecord[] {
    return Array.from(this.registry.values());
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
  }
}
