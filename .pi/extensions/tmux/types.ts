/**
 * Shared types, interfaces, constants, and error class for the tmux extension.
 * This is the "dictionary" for the entire extension — start here.
 */

// ─── Tool Input (discriminated union) ─────────────────────────

export interface TmuxRunInput {
  action: "run";
  command: string;
  label: string;
  interactive?: boolean;    // default: false
  waitOnExit?: boolean;     // default: false
  busChannel?: string;      // If set, auto-publish exit signal to this channel (crash-safe completion)
}

export interface TmuxSendInput {
  action: "send";
  paneId: string;
  text: string;
}

export interface TmuxReadInput {
  action: "read";
  paneId: string;
}

export interface TmuxCloseInput {
  action: "close";
  paneId: string;
  kill?: boolean;           // default: false (deregister only)
}

export type TmuxInput = TmuxRunInput | TmuxSendInput | TmuxReadInput | TmuxCloseInput;

// ─── Pane Registry ────────────────────────────────────────────

export interface PaneRecord {
  id: string;               // our ID: <session-prefix>-<short-hash>
  tmuxPaneId: string;       // tmux native: %0, %1, etc.
  label: string;
  command: string;
  interactive: boolean;
  waitOnExit: boolean;
  createdAt: number;
}

// ─── Tool Results ─────────────────────────────────────────────

export interface RunResult {
  paneId: string;
  tmuxPaneId: string;
}

export interface SendResult {
  ok: boolean;
  warning?: string;
}

export interface CloseResult {
  ok: boolean;
}

// ─── TmuxClient Interface (for DI) ───────────────────────────

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal; timeout?: number }
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface ITmuxClient {
  isInTmux(): boolean;
  splitWindow(
    direction: "right" | "below",
    command: string,
    targetPaneId?: string,             // when set, split relative to this pane
    sizePercent?: number,              // size of new pane as % of available space
  ): Promise<string>;                    // returns tmux pane ID

  // ── Batched hot-path methods (1 spawn each) ───────────────
  /** Set pane title — best-effort, cosmetic only. */
  setupPane(tmuxPaneId: string, title: string): Promise<void>;
  /** Send text literally then Enter in a single bash exec. */
  sendKeys(tmuxPaneId: string, text: string): Promise<void>;
  /** capture-pane — exit code determines alive status. No separate listPanes call. */
  capturePaneWithStatus(tmuxPaneId: string): Promise<{ content: string; alive: boolean }>;

  // ── Granular methods (used by reconstruct / kept for compat) ─
  killPane(tmuxPaneId: string): Promise<void>;
  setPaneTitle(tmuxPaneId: string, title: string): Promise<void>;
  listPanes(): Promise<string[]>;        // returns list of alive pane IDs
  isPaneAlive(tmuxPaneId: string): Promise<boolean>;
  capturePaneContent(tmuxPaneId: string): Promise<string>;
}

// ─── Config ──────────────────────────────────────────────────

export interface TmuxConfig {
  sessionPrefix: string;    // generated at init: 4-char random hex
}

export const DEFAULT_CONFIG: TmuxConfig = {
  sessionPrefix: "",         // set at runtime
};

// ─── Details (for session reconstruction) ────────────────────

export interface RunDetails {
  action: "run";
  paneId: string;
  tmuxPaneId: string;
  label: string;
  command: string;
  interactive: boolean;
  waitOnExit: boolean;
  createdAt: number;
}

// ─── Errors ──────────────────────────────────────────────────

export type TmuxErrorCode =
  | "NOT_IN_TMUX"
  | "PANE_NOT_FOUND"
  | "SPLIT_FAILED"
  | "SEND_FAILED"
  | "KILL_FAILED"
  | "CAPTURE_FAILED";

export class TmuxError extends Error {
  constructor(
    message: string,
    public code: TmuxErrorCode
  ) {
    super(message);
    this.name = "TmuxError";
  }
}
