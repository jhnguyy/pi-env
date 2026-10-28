import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorToHex, type Color } from "@earendil-works/pi-tui";
import { TmuxStatus, type StatusPalette, type StatusState } from "./tmux-status";

function tmuxColor(color: Color): string {
  return color.kind === "indexed" ? `colour${color.index}` : colorToHex(color);
}

function palette(ctx: ExtensionContext): StatusPalette {
  const colors = ctx.ui.theme.colors;
  return {
    running: tmuxColor(colors.accent),
    done: tmuxColor(colors.success),
    error: tmuxColor(colors.error),
    idle: tmuxColor(colors.muted),
  };
}

/** Owns one session's polling and drains its last write before removing metadata. */
class SessionStatus {
  private state: StatusState = "idle";
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly transport: TmuxStatus,
    private readonly ctx: ExtensionContext,
  ) {}

  set(state: StatusState): void {
    if (state !== this.state) this.revision++;
    this.state = state;
    this.refresh();
  }

  refresh(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.dirty = true;
    if (this.pending) return;
    this.pending = this.publish().finally(() => {
      this.pending = undefined;
      if (this.closed) return;
      if (this.dirty) this.refresh();
      else {
        // The public API exposes the current theme but no theme-change subscription.
        this.timer = setTimeout(() => this.refresh(), this.state === "running" ? 250 : 1000);
        this.timer.unref();
      }
    });
  }

  private async publish(): Promise<void> {
    this.dirty = false;
    try {
      await this.transport.update(this.state, palette(this.ctx), this.revision);
    } catch {
      // Status is best-effort and must not interrupt an agent run or shutdown.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.transport.close();
  }
}

export default function (pi: ExtensionAPI): void {
  let status: SessionStatus | undefined;
  let runActive = false;
  let result: Exclude<StatusState, "running"> = "done";

  pi.on("session_start", async (_event, ctx) => {
    await status?.close();
    status = undefined;
    runActive = false;
    result = "done";
    const pane = process.env.TMUX_PANE;
    if (ctx.mode !== "tui" || !process.env.TMUX || !pane || !/^%\d+$/.test(pane)) return;
    status = new SessionStatus(new TmuxStatus(pane), ctx);
    status.refresh();
  });

  pi.on("before_agent_start", () => {
    runActive = true;
    result = "done";
    status?.set("running");
  });
  pi.on("agent_start", () => {
    runActive = true;
    result = "done";
    status?.set("running");
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      switch (event.message.stopReason) {
        case "error":
          result = "error";
          break;
        case "aborted":
          result = "idle";
          break;
        default:
          result = "done";
      }
    }
  });
  pi.on("session_before_compact", () => {
    status?.set("running");
  });
  pi.on("session_compact", (event) => {
    if (!runActive && !event.willRetry) status?.set("done");
  });
  pi.on("session_compact_failed", (event) => {
    result = event.aborted ? "idle" : "error";
    if (!runActive && !event.willRetry) status?.set(result);
  });
  pi.on("agent_settled", (event, ctx) => {
    runActive = false;
    status?.set(event.aborted ? "idle" : result);
    if (ctx.mode === "tui") process.stdout.write("\u0007");
  });
  pi.on("session_shutdown", async () => {
    const closing = status;
    status = undefined;
    await closing?.close();
  });
}
