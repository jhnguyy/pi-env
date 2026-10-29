import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { statusDefinitions } from "./status";

export const leaderOption = "@pi_agent_ticker";
export const spinnerOption = "@pi_agent_spinner";

// Pi's default loader interval; frames follow the clock so transport latency skips
// frames instead of slowing the rotation.
const frameMs = 80;
const idleCheckMs = 1_000;
const retryMs = 5_000;
const frames = statusDefinitions.running.frames;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the recorded leader cannot still be ticking. */
function vacant(leader: string): boolean {
  const pid = Number(leader.split("-")[0]);
  return !leader || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid);
}

/**
 * One spinner clock per tmux server, shared by every Pi process that uses it.
 *
 * Any process with a running session may claim leadership through a compare-and-set
 * on a global option. The leader keeps one control-mode client attached with
 * no-output (so it never counts as viewing a window) and writes the current frame
 * to a global option that running indicators reference. It releases leadership
 * when no window is running, when its last local session closes, or when its
 * client exits; another running session then takes over.
 */
export class TmuxTicker {
  private readonly token = `${process.pid}-${randomUUID()}`;
  private readonly users = new Set<object>();
  private client: ChildProcess | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private claiming = false;
  private retryAfter = 0;
  private lastFrame = -1;

  constructor(private readonly args: string[]) {}

  private run(args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile(
        "tmux",
        [...this.args, ...args],
        { timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
  }

  get leading(): boolean {
    return this.client !== undefined;
  }

  /** Called by a running session with the leader value it last observed. */
  demand(user: object, pane: string, leader: string): void {
    this.users.add(user);
    if (this.client || this.claiming || Date.now() < this.retryAfter) return;
    if (leader !== this.token && !vacant(leader)) return;
    this.claiming = true;
    void this.claim(pane, leader).finally(() => {
      this.claiming = false;
    });
  }

  release(user: object): void {
    this.users.delete(user);
    if (!this.users.size) this.stop();
  }

  private async claim(pane: string, observed: string): Promise<void> {
    const claimed = await this.run([
      "if-shell",
      "-F",
      `#{==:#{${leaderOption}},${observed}}`,
      `set-option -g ${leaderOption} '${this.token}'`,
      ";",
      "display-message",
      "-p",
      "-t",
      pane,
      `#{${leaderOption}}|#{session_id}`,
    ]);
    const [winner, session] = claimed?.trim().split("|") ?? [];
    if (winner !== this.token || !/^\$\d+$/.test(session ?? "") || !this.users.size) return;
    // Attaching by pane would make that pane's window current; a session target does not.
    const client = spawn(
      "tmux",
      [...this.args, "-C", "attach-session", "-t", session, "-f", "no-output,ignore-size,read-only"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    client.stdin?.on("error", () => client.kill("SIGKILL"));
    client.once("exit", () => {
      if (this.client !== client) return;
      this.retryAfter = Date.now() + retryMs;
      this.stop();
    });
    this.client = client;
    this.lastFrame = -1;
    this.tick();
    this.watchIdle();
  }

  private tick(): void {
    if (!this.client) return;
    const now = Date.now();
    const frame = Math.floor(now / frameMs) % frames.length;
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.client.stdin?.write(`set-option -g ${spinnerOption} '${frames[frame]}'\n`);
    }
    this.frameTimer = setTimeout(() => this.tick(), frameMs - (now % frameMs));
    this.frameTimer.unref();
  }

  private watchIdle(): void {
    this.idleTimer = setTimeout(async () => {
      if (!this.client) return;
      const ranks = await this.run(["list-windows", "-a", "-F", "#{@pi_agent_rank}"]);
      const running = String(statusDefinitions.running.priority);
      if (ranks !== undefined && !ranks.split("\n").some((rank) => rank.startsWith(running)))
        this.stop();
      else this.watchIdle();
    }, idleCheckMs);
    this.idleTimer.unref();
  }

  private stop(): void {
    clearTimeout(this.frameTimer);
    clearTimeout(this.idleTimer);
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    client.stdin?.end();
    client.kill();
    void this.run([
      "if-shell",
      "-F",
      `#{==:#{${leaderOption}},${this.token}}`,
      `set-option -gu ${leaderOption}`,
    ]);
  }
}

const tickers = new Map<string, TmuxTicker>();

/** Shares one ticker per tmux socket within this process. */
export function tickerFor(args: string[]): TmuxTicker {
  const key = args.join("\0");
  let ticker = tickers.get(key);
  if (!ticker) {
    ticker = new TmuxTicker(args);
    tickers.set(key, ticker);
  }
  return ticker;
}
