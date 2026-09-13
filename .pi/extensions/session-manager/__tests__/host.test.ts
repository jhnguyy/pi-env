import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DuplicateWindowBinding,
  WindowBindingConflict,
  createTmuxSessionHost,
  type Exec,
} from "../index.js";

function executor(initialTags: Readonly<Record<string, string>>) {
  const tags: Record<string, string> = { ...initialTags };
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const format = args.at(-1);
    if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@2\n", stderr: "" };
    if (format === "#{socket_path}") return { code: 0, stdout: "/tmp/tmux.sock\n", stderr: "" };
    if (format === "#{session_id}") return { code: 0, stdout: "$1\n", stderr: "" };
    if (format === "#{window_id}") return { code: 0, stdout: "@1\n", stderr: "" };
    if (args.includes("show-options")) {
      const windowId = args[args.indexOf("-t") + 1];
      return { code: 0, stdout: `${tags[windowId] ?? ""}\n`, stderr: "" };
    }
    if (args.includes("set-option") && args.includes("@pi_session_id")) {
      const windowId = args[args.indexOf("-t") + 1];
      tags[windowId] = args.at(-1)!;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

describe("tmux session host", () => {
  it("binds and renames the current window with argv-safe values", async () => {
    const { calls, exec } = executor({});
    const host = createTmuxSessionHost(exec);
    const name = "quiet pine; $(touch nope)";

    await Effect.runPromise(host.bindCurrent("%1", "session-a", name));

    expect(calls).toContainEqual([
      "tmux",
      "-S",
      "/tmp/tmux.sock",
      "set-option",
      "-w",
      "-o",
      "-t",
      "@1",
      "@pi_session_id",
      "session-a",
    ]);
    expect(calls).toContainEqual([
      "tmux",
      "-S",
      "/tmp/tmux.sock",
      "rename-window",
      "-t",
      "@1",
      name,
    ]);
  });

  it("releases only the current session's owned window binding", async () => {
    const { calls, exec } = executor({ "@1": "session-a" });

    await Effect.runPromise(createTmuxSessionHost(exec).releaseCurrent("%1", "session-a"));

    expect(calls).toContainEqual([
      "tmux",
      "-S",
      "/tmp/tmux.sock",
      "set-option",
      "-w",
      "-u",
      "-t",
      "@1",
      "@pi_session_id",
    ]);
  });

  it("rejects an occupied current window and a duplicate binding before mutation", async () => {
    const occupied = executor({ "@1": "other" });
    expect(
      await failureOf(createTmuxSessionHost(occupied.exec).bindCurrent("%1", "session-a", "name")),
    ).toBeInstanceOf(WindowBindingConflict);
    expect(occupied.calls.some((call) => call.includes("set-option"))).toBe(false);

    const duplicate = executor({ "@2": "session-a" });
    expect(
      await failureOf(createTmuxSessionHost(duplicate.exec).bindCurrent("%1", "session-a", "name")),
    ).toBeInstanceOf(DuplicateWindowBinding);
    expect(duplicate.calls.some((call) => call.includes("set-option"))).toBe(false);
  });
});
