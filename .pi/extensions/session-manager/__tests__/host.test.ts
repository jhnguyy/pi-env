import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DuplicateWindowBinding,
  WindowBindingConflict,
  createTmuxSessionHost,
  type Exec,
} from "../host.js";

function executor(
  initialTags: Readonly<Record<string, string>>,
  initialOwners: Readonly<Record<string, string>> = {},
) {
  const options: Record<string, Record<string, string>> = {
    "@pi_session_id": { ...initialTags },
    "@pi_session_pid": { ...initialOwners },
  };
  const tags = options["@pi_session_id"];
  const owners = options["@pi_session_pid"];
  const calls: string[][] = [];
  let windowName = "zsh";
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const format = args.at(-1);
    if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@2\n", stderr: "" };
    if (format === "#{socket_path}") return { code: 0, stdout: "/tmp/tmux.sock\n", stderr: "" };
    if (format === "#{session_id}") return { code: 0, stdout: "$1\n", stderr: "" };
    if (format === "#{window_id}") return { code: 0, stdout: "@1\n", stderr: "" };
    if (format === "#{window_name}") return { code: 0, stdout: `${windowName}\n`, stderr: "" };
    if (args.includes("rename-window")) windowName = args.at(-1)!;
    const windowId = args[args.indexOf("-t") + 1];
    const option = Object.keys(options).find((name) => args.includes(name));
    if (args.includes("show-options") && option) {
      return { code: 0, stdout: `${options[option][windowId] ?? ""}\n`, stderr: "" };
    }
    if (args.includes("set-option") && option) {
      if (args.includes("-u")) delete options[option][windowId];
      else if (args.includes("-o") && options[option][windowId])
        return { code: 1, stdout: "", stderr: "already set" };
      else options[option][windowId] = args.at(-1)!;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec, tags, owners };
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

describe("tmux session host", () => {
  it("passes a user name with shell metacharacters as one argument", async () => {
    const { calls, exec } = executor({});
    const name = "quiet pine; $(touch nope)";
    await Effect.runPromise(createTmuxSessionHost(exec).bindCurrent("%1", "session-a", name));
    expect(calls.find((call) => call.includes("rename-window"))?.at(-1)).toBe(name);
  });

  it("labels an unnamed session's window with its session ID suffix until release", async () => {
    const { calls, exec } = executor({});
    const host = createTmuxSessionHost(exec);
    const sessionId = "01a0f87b-994a-704b-ba15-e36cc9f4b367";
    const automaticRename = (flag: string) =>
      calls.some(
        (call) => call.includes("automatic-rename") && call.includes(flag) && call.at(-2) === "@1",
      );

    await Effect.runPromise(host.bindCurrent("%1", sessionId));

    expect(calls.find((call) => call.includes("rename-window"))?.at(-1)).toBe("pi-f4b367");
    expect(calls.some((call) => call.includes("automatic-rename") && call.at(-1) === "off")).toBe(
      true,
    );

    await Effect.runPromise(host.releaseCurrent("%1", sessionId));

    expect(automaticRename("-u")).toBe(true);
  });

  it("keeps an explicit window name after release", async () => {
    const { calls, exec } = executor({});
    const host = createTmuxSessionHost(exec);

    await Effect.runPromise(host.bindCurrent("%1", "session-a", "troubleshooting"));
    await Effect.runPromise(host.releaseCurrent("%1", "session-a"));

    expect(calls.some((call) => call.includes("automatic-rename") && call.includes("-u"))).toBe(
      false,
    );
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

  it("restores a pending session once and reuses its binding", async () => {
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
    expect(creation).toContain(input.name);
    expect(creation).toContain(input.wrapperPath);
    expect(creation).toContain(input.sessionId);
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

    const live = executor({ "@1": "other" }, { "@1": "41" });
    const liveHost = createTmuxSessionHost(live.exec, { ownerPid: 42, processAlive: () => true });
    expect(await failureOf(liveHost.bindCurrent("%1", "session-a"))).toBeInstanceOf(
      WindowBindingConflict,
    );
    expect(live.tags["@1"]).toBe("other");
  });

  it("reclaims the current window from a Pi process that exited without releasing it", async () => {
    const stale = executor({ "@1": "exited-session" }, { "@1": "41" });
    const host = createTmuxSessionHost(stale.exec, {
      ownerPid: 42,
      processAlive: (pid) => pid !== 41,
    });

    await Effect.runPromise(host.bindCurrent("%1", "session-a"));

    expect(stale.tags["@1"]).toBe("session-a");
    expect(stale.owners["@1"]).toBe("42");
  });

  it("reclaims a binding left by an earlier session in the same Pi process", async () => {
    const earlier = executor({ "@1": "earlier-session" }, { "@1": "42" });
    const host = createTmuxSessionHost(earlier.exec, { ownerPid: 42, processAlive: () => true });

    await Effect.runPromise(host.bindCurrent("%1", "session-a"));

    expect(earlier.tags["@1"]).toBe("session-a");
  });

  it("removes the owner process with the binding on release", async () => {
    const owned = executor({ "@1": "session-a" }, { "@1": "42" });

    await Effect.runPromise(
      createTmuxSessionHost(owned.exec, { ownerPid: 42 }).releaseCurrent("%1", "session-a"),
    );

    expect(owned.tags["@1"]).toBeUndefined();
    expect(owned.owners["@1"]).toBeUndefined();
  });
});
