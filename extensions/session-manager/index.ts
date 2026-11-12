import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { getChildContext } from "../_shared/child-context";

const ownerOption = "@pi_naming_owner";
const labelOption = "@pi_naming_label";

// tmux parses command-list strings itself, independently of the shell.
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const literalName = (name: string): string => name.replaceAll("#", "##");
const commands = (...items: string[][]): string =>
  items.map((args) => args.map(quote).join(" ")).join(" ; ");

export default function sessionManager(pi: ExtensionAPI): void {
  if (getChildContext()) return;

  let binding: { pane: string; token: string; fallback: string } | undefined;
  let stopped = false;
  let pending = Promise.resolve();

  const run = async (args: string[]): Promise<void> => {
    const result = await pi.exec("tmux", args, { timeout: 2000, maxBuffer: 16_384 });
    if (result.code !== 0 || result.killed) {
      throw new Error(result.stderr.trim() || "tmux naming command failed");
    }
  };
  const enqueue = (ctx: ExtensionContext, operation: () => Promise<void>): Promise<void> => {
    pending = pending.then(operation).catch((error: unknown) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Tmux naming: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    });
    return pending;
  };

  pi.on("session_start", (_event, ctx) => {
    const pane = process.env.TMUX_PANE;
    if (stopped || ctx.mode !== "tui" || !process.env.TMUX || !pane || !/^%\d+$/.test(pane)) {
      return;
    }
    const token = `${pane}:${randomUUID()}`;
    binding = { pane, token, fallback: `pi-${ctx.sessionManager.getSessionId().slice(-6)}` };
    const label = pi.getSessionName() || binding.fallback;
    // UUIDv7 IDs share a timestamp prefix; their random tail distinguishes nearby sessions.
    return enqueue(ctx, async () => {
      // A same-pane successor may reclaim a stale token, but never a manual rename.
      // Conditions and mutations run together on tmux's command queue, not via read/write IO.
      const unowned = `#{&&:#{==:#{${ownerOption}},},#{automatic-rename}}`;
      const successor = `#{&&:#{m:${pane}:*,#{${ownerOption}}},#{==:#{window_name},#{${labelOption}}}}`;
      await run([
        "if-shell",
        "-F",
        "-t",
        pane,
        `#{||:${unowned},${successor}}`,
        commands(
          ["set-option", "-w", "-t", pane, ownerOption, token],
          ["rename-window", "-t", pane, "--", literalName(label)],
          ["set-option", "-wF", "-t", pane, labelOption, "#{window_name}"],
        ),
      ]);
    });
  });

  pi.on("session_info_changed", (event, ctx) => {
    const current = binding;
    if (stopped || !current) return;
    const label = event.name || current.fallback;
    return enqueue(ctx, () =>
      run([
        "if-shell",
        "-F",
        "-t",
        current.pane,
        `#{&&:#{==:#{${ownerOption}},${current.token}},#{==:#{window_name},#{${labelOption}}}}`,
        commands(
          ["rename-window", "-t", current.pane, "--", literalName(label)],
          ["set-option", "-wF", "-t", current.pane, labelOption, "#{window_name}"],
        ),
      ]),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (stopped) return pending;
    stopped = true;
    const current = binding;
    binding = undefined;
    if (!current) return pending;
    return enqueue(ctx, () =>
      run([
        "if-shell",
        "-F",
        "-t",
        current.pane,
        `#{==:#{${ownerOption}},${current.token}}`,
        commands(
          [
            "if-shell",
            "-F",
            "-t",
            current.pane,
            `#{==:#{window_name},#{${labelOption}}}`,
            commands(["set-option", "-w", "-t", current.pane, "automatic-rename", "on"]),
          ],
          ["set-option", "-wu", "-t", current.pane, ownerOption],
          ["set-option", "-wu", "-t", current.pane, labelOption],
        ),
      ]),
    );
  });
}
