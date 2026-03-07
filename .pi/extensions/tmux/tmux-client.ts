/**
 * TmuxClient — thin shell wrapper around tmux commands.
 *
 * All tmux I/O lives here. Pure side-effect boundary.
 * Constructor takes an injectable ExecFn for testability (follows the
 * NotesApiClient pattern with injectable fetchFn).
 */

import type { ExecFn, ITmuxClient } from "./types";
import { TmuxError } from "./types";

export class TmuxClient implements ITmuxClient {
  constructor(private execFn: ExecFn) {}

  // ─── isInTmux ────────────────────────────────────────────────

  isInTmux(): boolean {
    return !!process.env.TMUX;
  }

  // ─── splitWindow ─────────────────────────────────────────────

  async splitWindow(direction: "right" | "below", command: string, targetPaneId?: string, sizePercent?: number): Promise<string> {
    const flag = direction === "right" ? "-h" : "-v";
    const args = ["split-window", flag, "-d", "-P", "-F", "#{pane_id}"];
    if (sizePercent) args.push("-l", `${sizePercent}%`);
    if (targetPaneId) args.push("-t", targetPaneId);
    args.push(command);
    const result = await this.execFn("tmux", args);
    if (result.code !== 0) {
      throw new TmuxError(
        `split-window failed: ${result.stderr || result.stdout}`,
        "SPLIT_FAILED",
      );
    }
    return result.stdout.trim();
  }

  // ─── sendKeys ────────────────────────────────────────────────

  async sendKeys(tmuxPaneId: string, text: string): Promise<void> {
    // Batched: literal text + Enter in a single bash exec (1 spawn instead of 2).
    // Positional params ($1/$2) pass paneId and text safely without shell quoting —
    // arbitrary text content (quotes, backslashes, etc.) is handled correctly.
    const result = await this.execFn("bash", [
      "-c",
      'tmux send-keys -t "$1" -l "$2" && tmux send-keys -t "$1" "Enter"',
      "_",        // $0 (argv[0] for the bash -c script)
      tmuxPaneId, // $1
      text,       // $2
    ]);
    if (result.code !== 0) {
      throw new TmuxError(
        `send-keys failed: ${result.stderr || result.stdout}`,
        "SEND_FAILED",
      );
    }
  }

  // ─── setupPane ───────────────────────────────────────────────

  async setupPane(tmuxPaneId: string, title: string): Promise<void> {
    // Set pane title — best-effort, cosmetic only.
    const result = await this.execFn("tmux", ["select-pane", "-t", tmuxPaneId, "-T", title]);
    if (result.code !== 0) {
      console.error(`[tmux] setupPane title failed (ignored): ${result.stderr || result.stdout}`);
    }
  }

  // ─── capturePaneWithStatus ───────────────────────────────────

  async capturePaneWithStatus(tmuxPaneId: string): Promise<{ content: string; alive: boolean }> {
    // Single exec: non-zero exit means pane is dead or missing (1 spawn instead of 2).
    const result = await this.execFn("tmux", ["capture-pane", "-p", "-t", tmuxPaneId]);
    if (result.code !== 0) {
      return { content: "", alive: false };
    }
    return { content: result.stdout, alive: true };
  }

  // ─── killPaneAndRebalance ────────────────────────────────────

  // ─── killPane ────────────────────────────────────────────────

  async killPane(tmuxPaneId: string): Promise<void> {
    const result = await this.execFn("tmux", ["kill-pane", "-t", tmuxPaneId]);
    if (result.code !== 0) {
      // Silently tolerate "pane not found" — it's already dead
      const msg = result.stderr + result.stdout;
      if (msg.includes("no pane") || msg.includes("not found") || msg.includes("can't find")) {
        return;
      }
      throw new TmuxError(
        `kill-pane failed: ${result.stderr || result.stdout}`,
        "KILL_FAILED",
      );
    }
  }

  // ─── setPaneTitle ────────────────────────────────────────────

  async setPaneTitle(tmuxPaneId: string, title: string): Promise<void> {
    // Best-effort — log and continue on failure
    const result = await this.execFn("tmux", ["select-pane", "-t", tmuxPaneId, "-T", title]);
    if (result.code !== 0) {
      console.error(`[tmux] setPaneTitle failed (ignored): ${result.stderr || result.stdout}`);
    }
  }

  // ─── listPanes ───────────────────────────────────────────────

  async listPanes(): Promise<string[]> {
    const result = await this.execFn("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}",
    ]);
    if (result.code !== 0) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
  }

  // ─── isPaneAlive ─────────────────────────────────────────────

  async isPaneAlive(tmuxPaneId: string): Promise<boolean> {
    const panes = await this.listPanes();
    return panes.includes(tmuxPaneId);
  }

  // ─── capturePaneContent ──────────────────────────────────────

  async capturePaneContent(tmuxPaneId: string): Promise<string> {
    const result = await this.execFn("tmux", ["capture-pane", "-p", "-t", tmuxPaneId]);
    if (result.code !== 0) {
      throw new TmuxError(
        `capture-pane failed: ${result.stderr || result.stdout}`,
        "CAPTURE_FAILED",
      );
    }
    return result.stdout;
  }


}
