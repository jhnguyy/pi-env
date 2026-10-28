import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { isStatusState, statusDefinitions, type StatusState } from "./status";

export interface TmuxStatusOptions {
  socketPath?: string;
  timeoutMs?: number;
}

const colorPattern =
  /^(?:#[0-9a-fA-F]{6}|colour(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))$/;
const ownerOption = "@pi_agent_owner";
const paneOption = "@pi_agent_pane_status";
const windowOption = "@pi_agent_status";

interface PaneStatus {
  pane: string;
  window: string;
  owner: string;
  value: string;
  state: StatusState;
  seen: boolean;
  color: string;
  frame: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parsePane(line: string): PaneStatus | undefined {
  const [pane, window, owner, state, seen, color, frame] = line.split("|");
  if (
    !/^%\d+$/.test(pane) ||
    !/^@\d+$/.test(window) ||
    !/^[1-9]\d*-[0-9a-f-]{36}$/.test(owner) ||
    !isStatusState(state) ||
    (seen !== "0" && seen !== "1") ||
    !colorPattern.test(color) ||
    !/^[0-9]$/.test(frame) ||
    Number(frame) >= statusDefinitions[state].frames.length
  )
    return undefined;
  return {
    pane,
    window,
    owner,
    value: [state, seen, color, frame].join("|"),
    state,
    seen: seen === "1",
    color,
    frame: Number(frame),
  };
}

// These strings are parsed by tmux, never by a shell. Every interpolated field
// comes from a validated ID, token, palette, or our own fixed vocabulary.
function equal(option: string, value: string): string {
  return `#{==:#{${option}},${value}}`;
}

function guarded(pane: PaneStatus, command: string): string[] {
  return [
    "if-shell",
    "-F",
    "-t",
    pane.pane,
    `#{&&:${equal(ownerOption, pane.owner)},${equal(paneOption, pane.value)}}`,
    command,
  ];
}

function batch(commands: string[][]): string[] {
  return commands.flatMap((command, index) => (index ? [";", ...command] : command));
}

function windowRows(output: string): Map<string, string[]> {
  const windows = new Map<string, string[]>();
  const visited = new Set<string>();
  for (const line of output.trim().split("\n")) {
    const [pane, window] = line.split("|");
    if (!/^%\d+$/.test(pane) || !/^@\d+$/.test(window) || visited.has(pane)) continue;
    // Linked windows appear once per session in list-panes -a.
    visited.add(pane);
    const rows = windows.get(window) ?? [];
    rows.push(line);
    windows.set(window, rows);
  }
  return windows;
}

interface WindowSnapshot {
  panes: PaneStatus[];
  values: string[];
  commands: string[][];
}

function acknowledge(rows: string[], viewed: boolean): WindowSnapshot {
  const snapshot: WindowSnapshot = { panes: [], values: [], commands: [] };
  for (const line of rows) {
    const [id, , token, ...fields] = line.split("|");
    let value = `${id}|${token}|${fields.join("|")}~`;
    const pane = parsePane(line);
    if (pane) {
      const pid = Number(pane.owner.split("-")[0]);
      if (!Number.isSafeInteger(pid) || !alive(pid)) {
        snapshot.commands.push(
          guarded(
            pane,
            `set-option -p -u -t ${pane.pane} ${ownerOption} ; set-option -p -u -t ${pane.pane} ${paneOption}`,
          ),
        );
        value = `${pane.pane}||~`;
      } else {
        if (viewed && !pane.seen) {
          const acknowledged = `${pane.state}|1|${pane.color}|${pane.frame}`;
          snapshot.commands.push(
            guarded(pane, `set-option -p -t ${pane.pane} ${paneOption} '${acknowledged}'`),
          );
          pane.seen = true;
          value = `${pane.pane}|${pane.owner}|${acknowledged}~`;
        }
        snapshot.panes.push(pane);
      }
    }
    snapshot.values.push(value);
  }
  return snapshot;
}

function windowCommand(window: string, snapshot: WindowSnapshot): string[] | undefined {
  snapshot.panes.sort(
    (a, b) =>
      statusDefinitions[b.state].priority - statusDefinitions[a.state].priority ||
      Number(a.pane.slice(1)) - Number(b.pane.slice(1)),
  );
  const winner = snapshot.panes[0];
  // push-default/pop-default confines styling to the indicator, preserving
  // both inactive names and the active window's background/highlight.
  const indicator = winner
    ? `#[push-default]#[fg=${winner.color},nobold,nodim,${winner.seen ? "dim" : "bold"}]${statusDefinitions[winner.state].frames[winner.frame]}#[pop-default]`
    : "";
  // P: iterates pane IDs, whereas list-panes follows layout indices.
  const expected = snapshot.values
    .sort((a, b) => Number.parseInt(a.slice(1), 10) - Number.parseInt(b.slice(1), 10))
    .join("");
  // Reject a stale aggregate if another poll changed membership or metadata.
  // Do not interpolate malformed/foreign option values into tmux formats.
  if (!/^[a-zA-Z0-9|#%~\-]*$/.test(expected)) return undefined;
  return [
    "if-shell",
    "-F",
    "-t",
    window,
    `#{==:#{P:#{pane_id}|#{${ownerOption}}|#{${paneOption}}~},${expected}}`,
    winner
      ? `set-option -w -t ${window} ${windowOption} '${indicator}'`
      : `set-option -w -u -t ${window} ${windowOption}`,
  ];
}

/** Best-effort transport. The caller owns polling; close drains pending work. */
export class TmuxStatus {
  private readonly owner = `${process.pid}-${randomUUID()}`;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly valid: boolean;
  private claimed = false;
  private closed = false;
  private state: StatusState | undefined;
  private revision: number | undefined;
  private frame = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly pane: string,
    options: TmuxStatusOptions = {},
  ) {
    this.valid = /^%\d+$/.test(pane);
    this.args = options.socketPath ? ["-S", options.socketPath] : [];
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 5_000))
      : 1_000;
  }

  private run(args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      // execFile waits for close after SIGKILL, so a timed-out child cannot
      // accumulate behind subsequent polls. Output is bounded as well.
      execFile(
        "tmux",
        [...this.args, ...args],
        {
          timeout: this.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
  }

  update(state: StatusState, color: string, revision?: number): Promise<void> {
    if (this.closed || !this.valid || !isStatusState(state) || !colorPattern.test(color))
      return Promise.resolve();
    this.pending = this.pending.then(async () => {
      // A coalesced running -> done cycle must rearm attention even if the
      // previous published state was also done.
      const unchanged = state === this.state && revision === this.revision;
      this.frame = unchanged ? (this.frame + 1) % statusDefinitions[state].frames.length : 0;
      this.state = state;
      this.revision = revision;
      // Read acknowledgement at the write boundary: another pane's poll may
      // have marked this pane viewed since our previous update.
      const seen = unchanged ? `#{?#{m:${state}|1|*,#{${paneOption}}},1,0}` : "0";
      const value = `${state}|0|${color}|${this.frame}`;
      const set = `set-option -p -F -t ${this.pane} ${paneOption} '${state}|${seen}|${color}|${this.frame}'`;
      const commands = this.claimed
        ? ["if-shell", "-F", "-t", this.pane, equal(ownerOption, this.owner), set]
        : batch([
            ["set-option", "-p", "-t", this.pane, ownerOption, this.owner],
            ["set-option", "-p", "-t", this.pane, paneOption, value],
          ]);
      if ((await this.run(commands)) === undefined) return;
      this.claimed = true;
      await this.aggregate();
    });
    return this.pending;
  }

  private async aggregate(): Promise<void> {
    const output = await this.run([
      "list-panes",
      "-a",
      "-F",
      `#{pane_id}|#{window_id}|#{${ownerOption}}|#{${paneOption}}`,
    ]);
    if (output === undefined) return;
    const clients = await this.run(["list-clients", "-F", "#{window_id}"]);
    if (clients === undefined) return;
    const viewed = new Set(clients.trim().split("\n"));
    const commands: string[][] = [];
    for (const [window, rows] of windowRows(output)) {
      const snapshot = acknowledge(rows, viewed.has(window));
      commands.push(...snapshot.commands);
      const command = windowCommand(window, snapshot);
      if (command) commands.push(command);
    }
    if (commands.length) await this.run(batch(commands));
  }

  close(): Promise<void> {
    if (this.closed) return this.pending;
    this.closed = true;
    if (!this.valid) return this.pending;
    this.pending = this.pending.then(async () => {
      if (!this.claimed) return;
      await this.run([
        "if-shell",
        "-F",
        "-t",
        this.pane,
        equal(ownerOption, this.owner),
        `set-option -p -u -t ${this.pane} ${ownerOption} ; set-option -p -u -t ${this.pane} ${paneOption}`,
      ]);
      await this.aggregate();
    });
    return this.pending;
  }
}
