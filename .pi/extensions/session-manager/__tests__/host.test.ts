import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DuplicateWindowBinding,
  WindowBindingConflict,
  createTmuxSessionHost,
  type Exec,
} from "../host.js";

function executor(initialTags: Readonly<Record<string, string>>) {
  const tags: Record<string, string> = { ...initialTags };
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const format = args.at(-1);
    if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@2\n", stderr: "" };
    if (args.includes("new-window")) return { code: 0, stdout: "@3\n", stderr: "" };
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

  it("binds an unnamed session without changing its tmux window title", async () => {
    const { calls, exec } = executor({});
    await Effect.runPromise(createTmuxSessionHost(exec).bindCurrent("%1", "session-a"));
    expect(calls.some((call) => call.includes("rename-window"))).toBe(false);
    expect(calls).toContainEqual([
      "tmux",
      "-S",
      "/tmp/tmux.sock",
      "set-option",
      "-w",
      "-u",
      "-t",
      "@1",
      "automatic-rename",
    ]);
    expect(calls.some((call) => call.includes("@pi_session_id"))).toBe(true);
  });

  it("creates an unnamed restored window without an explicit title", async () => {
    const { calls, exec } = executor({});
    await Effect.runPromise(
      createTmuxSessionHost(exec).restoreWindow!({
        paneId: "%1",
        sessionId: "session-a",
        cwd: "/tmp/work",
        wrapperPath: "/tmp/pi",
        extensionPath: "/tmp/extension",
        workspaceId: "a".repeat(64),
        coordinatorSessionId: "coordinator-a",
        launchId: "launch-a",
        persistence: { state: "pending" },
      }),
    );
    const creation = calls.find((call) => call.includes("new-window"));
    expect(creation).toBeDefined();
    expect(creation).not.toContain("-n");
    expect(creation).not.toContain("--name");
    expect(calls.some((call) => call.includes("automatic-rename"))).toBe(false);
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

  it("restores a pending session in one detached argv-safe window and reuses its binding", async () => {
    const { calls, exec: baseExec } = executor({});
    let created = false;
    const exec: Exec = async (command, args) => {
      if (args.includes("new-window")) {
        calls.push([command, ...args]);
        created = true;
        return { code: 0, stdout: "@3\n", stderr: "" };
      }
      if (created && args.includes("list-windows")) {
        calls.push([command, ...args]);
        return { code: 0, stdout: "@1\n@2\n@3\n", stderr: "" };
      }
      return baseExec(command, args);
    };
    const host = createTmuxSessionHost(exec);
    const input = {
      paneId: "%1",
      sessionId: "session with spaces",
      name: "quiet pine; literal",
      explicitName: true as const,
      cwd: "/tmp/work space",
      wrapperPath: "/opt/pi env/bin/pi",
      extensionPath: "/opt/pi env/session manager/index.js",
      workspaceId: "a".repeat(64),
      coordinatorSessionId: "coordinator-a",
      launchId: "launch-a",
      persistence: { state: "pending" as const },
    };

    const restored = await Effect.runPromise(host.restoreWindow!(input));
    const repeated = await Effect.runPromise(host.restoreWindow!(input));

    expect(restored).toEqual({ state: "created", windowId: "@3" });
    expect(repeated).toEqual({ state: "existing", windowId: "@3" });
    expect(calls.filter((call) => call.includes("new-window"))).toHaveLength(1);
    const creation = calls.find((call) => call.includes("new-window"));
    expect(creation).toEqual([
      "tmux",
      "-S",
      "/tmp/tmux.sock",
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      "$1:",
      "-n",
      input.name,
      "-c",
      input.cwd,
      "-e",
      "PI_ENV_SESSION_MANAGER_EXPECTED=1",
      "-e",
      "PI_ENV_SESSION_MANAGER_ROLE=work",
      "-e",
      `PI_ENV_SESSION_MANAGER_WORKSPACE_ID=${input.workspaceId}`,
      "-e",
      `PI_ENV_SESSION_MANAGER_COORDINATOR_ID=${input.coordinatorSessionId}`,
      "-e",
      `PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID=${input.sessionId}`,
      "-e",
      `PI_ENV_SESSION_MANAGER_LAUNCH_ID=${input.launchId}`,
      "-e",
      `PI_ENV_SESSION_MANAGER_EXTENSION=${input.extensionPath}`,
      "--",
      input.wrapperPath,
      "--session-id",
      input.sessionId,
      "--name",
      input.name,
      "--extension",
      input.extensionPath,
    ]);
  });

  it("accepts a child that wins the window-tag race only when it writes the expected identity", async () => {
    const tags: Record<string, string> = {};
    const exec: Exec = async (_command, args) => {
      const format = args.at(-1);
      if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@3\n", stderr: "" };
      if (format === "#{socket_path}") return { code: 0, stdout: "/tmp/tmux.sock\n", stderr: "" };
      if (format === "#{session_id}") return { code: 0, stdout: "$1\n", stderr: "" };
      if (format === "#{window_id}") return { code: 0, stdout: "@1\n", stderr: "" };
      if (args.includes("new-window")) return { code: 0, stdout: "@3\n", stderr: "" };
      if (args.includes("show-options")) {
        const windowId = args[args.indexOf("-t") + 1];
        return { code: 0, stdout: `${tags[windowId] ?? ""}\n`, stderr: "" };
      }
      if (args.includes("set-option") && args.includes("-o")) {
        tags["@3"] = "session-a";
        return { code: 1, stdout: "", stderr: "already set" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(
      Effect.runPromise(
        createTmuxSessionHost(exec).restoreWindow!({
          paneId: "%1",
          sessionId: "session-a",
          name: "quiet-pine",
          cwd: "/tmp/workspace",
          wrapperPath: "/bin/pi",
          extensionPath: "/extension.js",
          workspaceId: "a".repeat(64),
          coordinatorSessionId: "coordinator-a",
          launchId: "launch-a",
          persistence: { state: "pending" },
        }),
      ),
    ).resolves.toEqual({ state: "created", windowId: "@3" });
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
