import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  DuplicateWindowBinding,
  WindowBindingConflict,
  createTmuxSessionHost,
  type Exec,
} from "../host.js";

function testSocket(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-session-host-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tmux.sock");
}

function executor(
  initialTags: Readonly<Record<string, string>>,
  initialOwners: Readonly<Record<string, string>> = {},
) {
  const socketPath = testSocket();
  const options: Record<string, Record<string, string>> = {
    "@pi_session_id": { ...initialTags },
    "@pi_session_pid": { ...initialOwners },
  };
  const tags = options["@pi_session_id"];
  const owners = options["@pi_session_pid"];
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const format = args.at(-1);
    if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@2\n", stderr: "" };
    if (format === "#{socket_path}") return { code: 0, stdout: `${socketPath}\n`, stderr: "" };
    if (format === "#{session_id}") return { code: 0, stdout: "$1\n", stderr: "" };
    if (format === "#{window_id}") return { code: 0, stdout: "@1\n", stderr: "" };
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
  // Real Pi cannot reliably pause exactly after observing a dead PID. Gate that
  // IO here: a contender must not inspect/reclaim until the winner has verified.
  it("serializes a dead-owner reclaim through verification", { timeout: 10_000 }, async () => {
    const state = executor({ "@1": "dead" }, { "@1": "99" });
    let observed!: () => void;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    const exec: Exec = async (command, args) => {
      const result = await state.exec(command, args);
      if (!paused && args.includes("show-options") && args.includes("@pi_session_pid")) {
        paused = true;
        observed();
        await gate;
      }
      return result;
    };
    const a = createTmuxSessionHost(exec, { ownerPid: 41, processAlive: (pid) => pid !== 99 });
    const b = createTmuxSessionHost(exec, { ownerPid: 42, processAlive: (pid) => pid !== 99 });
    const first = Effect.runPromise(a.bindCurrent("%1", "a"));
    await observation;
    const second = Effect.runPromise(Effect.result(b.bindCurrent("%2", "b")));
    // Keep A paused until B finishes (bounded lock contention must fail closed).
    // Without serialization B succeeds, then A erases its verified live binding.
    const result = await second;
    resume();
    await first;
    expect(result._tag).toBe("Failure");
    expect(state.tags["@1"]).toBe("a");
    expect(state.owners["@1"]).toBe("41");
    expect(await failureOf(b.bindCurrent("%2", "b"))).toBeInstanceOf(WindowBindingConflict);
  });

  // E2E cannot inject a command failure inside a held lock. A failed mutation
  // must release ownership so the next transaction can complete.
  it("releases serialization after a failed tmux command", async () => {
    const state = executor({});
    const broken: Exec = async (command, args) =>
      args.includes("set-option")
        ? { code: 1, stdout: "", stderr: "injected tmux failure" }
        : state.exec(command, args);
    expect(
      (await Effect.runPromise(Effect.result(createTmuxSessionHost(broken).bindCurrent("%1", "a"))))
        ._tag,
    ).toBe("Failure");
    await Effect.runPromise(createTmuxSessionHost(state.exec).bindCurrent("%1", "a"));
    expect(state.tags["@1"]).toBe("a");
  });

  // E2E cannot pause an uncancellable tmux command while aborting its Effect.
  // The lock must remain held until that command completes.
  it("drains interrupted IO before releasing the lock", { timeout: 10_000 }, async () => {
    const state = executor({});
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const exec: Exec = async (command, args) => {
      if (args.includes("set-option") && args.includes("@pi_session_pid")) {
        entered();
        await gate;
      }
      return state.exec(command, args);
    };
    const controller = new AbortController();
    const first = Effect.runPromise(createTmuxSessionHost(exec).bindCurrent("%1", "a"), {
      signal: controller.signal,
    }).then(
      () => "completed",
      () => "interrupted",
    );
    await pending;
    controller.abort();
    const successor = createTmuxSessionHost(state.exec);
    const blocked = await Effect.runPromise(Effect.result(successor.bindCurrent("%1", "b")));
    resume();
    await first;
    expect(blocked._tag).toBe("Failure");
    expect(state.tags["@1"]).toBe("a");
    await Effect.runPromise(successor.bindCurrent("%1", "b"));
    expect(state.tags["@1"]).toBe("b");
  });

  // Real start E2E covers launch argv (including paths with spaces), but cannot
  // reliably repeat restore before the child enrolls. Reuse the parent's tag
  // even while the restored window has no owner PID yet.
  it("reuses a restored window before the child tags ownership", async () => {
    const { exec: baseExec } = executor({});
    let created = false;
    const exec: Exec = async (command, args) => {
      if (args.includes("new-window")) {
        created = true;
        return { code: 0, stdout: "@3\n", stderr: "" };
      }
      if (created && args.includes("list-windows"))
        return { code: 0, stdout: "@1\n@2\n@3\n", stderr: "" };
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
  });

  it("accepts a child that wins the window-tag race only when it writes the expected identity", async () => {
    const tags: Record<string, string> = {};
    const socketPath = testSocket();
    const exec: Exec = async (_command, args) => {
      const format = args.at(-1);
      if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@3\n", stderr: "" };
      if (format === "#{socket_path}") return { code: 0, stdout: `${socketPath}\n`, stderr: "" };
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

  // E2E cannot leave an earlier binding through the normal session transition,
  // which releases it. A leftover owned by this live PID must still be reclaimed.
  it("reclaims a binding left by an earlier session in the same Pi process", async () => {
    const earlier = executor({ "@1": "earlier-session" }, { "@1": "42" });
    const host = createTmuxSessionHost(earlier.exec, { ownerPid: 42, processAlive: () => true });

    await Effect.runPromise(host.bindCurrent("%1", "session-a"));

    expect(earlier.tags["@1"]).toBe("session-a");
  });
});
