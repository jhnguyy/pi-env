import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withChildContext } from "../../_shared/child-context";
import sessionManager from "../index";

const execute = promisify(execFile);
const sessionId = "019553e0-0000-7000-8000-012345abcdef";

describe("tmux naming on a private server", () => {
  let directory: string;
  let socket: string;
  let pane: string;

  const tmux = async (...args: string[]): Promise<string> => {
    const result = await execute("tmux", ["-S", socket, ...args], {
      env: { ...process.env, TMUX: "", PI_CODING_AGENT_DIR: join(directory, "agent") },
    });
    return result.stdout.trim();
  };
  const name = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
  const option = (key: string) => tmux("show-options", "-wqv", "-t", pane, key);

  function runtime(options: { name?: string; mode?: ExtensionContext["mode"] } = {}) {
    const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
    const notify = vi.fn<ExtensionContext["ui"]["notify"]>();
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      try {
        return {
          stdout: await tmux(...args),
          stderr: "",
          code: 0,
          killed: false,
          truncated: false,
        };
      } catch (error) {
        return { stdout: "", stderr: String(error), code: 1, killed: false, truncated: false };
      }
    });
    const pi: Pick<ExtensionAPI, "on" | "exec" | "getSessionName"> = {
      on: (event, handler) => {
        handlers.set(event, handler as (event: ExtensionEvent, ctx: ExtensionContext) => unknown);
        return () => {
          handlers.delete(event);
        };
      },
      exec,
      getSessionName: () => options.name,
    };
    const ctx: Pick<ExtensionContext, "mode" | "hasUI"> & {
      sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
      ui: Pick<ExtensionContext["ui"], "notify">;
    } = {
      mode: options.mode ?? "tui",
      hasUI: options.mode !== "print" && options.mode !== "json",
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify },
    };
    // Unused host services stay absent so accidental new effects fail this fixture.
    sessionManager(pi as ExtensionAPI);
    return {
      exec,
      notify,
      emit: async (event: ExtensionEvent) => {
        await handlers.get(event.type)?.(event, ctx as ExtensionContext);
      },
    };
  }
  const start = { type: "session_start", reason: "startup" } as const;
  const shutdown = { type: "session_shutdown", reason: "quit" } as const;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-naming-"));
    socket = join(directory, "tmux.sock");
    // -f /dev/null prevents loading personal tmux config; every command pins this socket.
    pane = await tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
    vi.stubEnv("TMUX", `${socket},0,0`);
    vi.stubEnv("TMUX_PANE", pane);
    await tmux("set-option", "-w", "-t", pane, "automatic-rename", "on");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      if (socket) await tmux("kill-server");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the random ID tail without writing a native name and releases on shutdown", async () => {
    const app = runtime();
    expect(app.exec).not.toHaveBeenCalled();
    await app.emit(start);
    expect(await name()).toBe("pi-abcdef");
    expect(await option("automatic-rename")).toBe("off");
    expect(await option("@pi_naming_owner")).not.toBe("");
    await app.emit(shutdown);
    expect(await option("@pi_naming_owner")).toBe("");
    expect(await option("@pi_naming_label")).toBe("");
    expect(await option("automatic-rename")).toBe("on");
    const calls = app.exec.mock.calls.length;
    await app.emit(shutdown);
    await app.emit({ type: "session_info_changed", name: "late" });
    expect(app.exec).toHaveBeenCalledTimes(calls);
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("uses explicit native names, follows rename events, and falls back when cleared", async () => {
    const app = runtime({ name: "work plan" });
    await app.emit(start);
    expect(await name()).toBe("work plan");
    const literal = "quotes \" \\ $HOME `ignored`; #{window_id}, braces } apostrophe ' end";
    await app.emit({ type: "session_info_changed", name: literal });
    // tmux renders backslashes visibly in window names, even with direct rename-window.
    expect(await name()).toBe(literal.replaceAll("\\", "\\\\"));
    await app.emit({ type: "session_info_changed", name: "next" });
    expect(await name()).toBe("next");
    await app.emit({ type: "session_info_changed", name: undefined });
    expect(await name()).toBe("pi-abcdef");
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("allows a same-pane successor without letting the old owner rename or release it", async () => {
    const old = runtime({ name: "old" });
    await old.emit(start);
    const oldToken = await option("@pi_naming_owner");
    const next = runtime({ name: "successor" });
    await next.emit(start);
    const nextToken = await option("@pi_naming_owner");
    expect(nextToken).not.toBe(oldToken);
    await old.emit({ type: "session_info_changed", name: "stale" });
    await old.emit(shutdown);
    expect(await name()).toBe("successor");
    expect(await option("@pi_naming_owner")).toBe(nextToken);
    expect(await option("automatic-rename")).toBe("off");
    await next.emit(shutdown);
    const replacement = runtime({ name: "resumed" });
    await replacement.emit({ type: "session_start", reason: "resume" });
    expect(await name()).toBe("resumed");
  });

  it("preserves manual renames during ownership and at the next startup", async () => {
    const app = runtime({ name: "work" });
    await app.emit(start);
    await tmux("rename-window", "-t", pane, "personal label");
    await app.emit({ type: "session_info_changed", name: "ignored" });
    expect(await name()).toBe("personal label");
    const successor = runtime({ name: "also ignored" });
    await successor.emit(start);
    await successor.emit(shutdown);
    expect(await name()).toBe("personal label");
    await app.emit(shutdown);
    expect(await option("@pi_naming_owner")).toBe("");
    expect(await option("automatic-rename")).toBe("off");
    await runtime({ name: "still ignored" }).emit(start);
    expect(await name()).toBe("personal label");
  });

  it("lets the first split pane own the window without a competing pane stealing it", async () => {
    const first = runtime({ name: "first" });
    await first.emit(start);
    const token = await option("@pi_naming_owner");
    const split = await tmux(
      "split-window",
      "-d",
      "-t",
      pane,
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    );
    vi.stubEnv("TMUX_PANE", split);
    const second = runtime({ name: "second" });
    await second.emit(start);
    await second.emit({ type: "session_info_changed", name: "not mine" });
    await second.emit(shutdown);
    expect(await name()).toBe("first");
    expect(await option("@pi_naming_owner")).toBe(token);
    await first.emit(shutdown);
    await runtime({ name: "new owner" }).emit(start);
    expect(await name()).toBe("new owner");
  });

  it("serializes concurrent split-pane claims on the tmux server", async () => {
    const first = runtime({ name: "one" });
    const split = await tmux(
      "split-window",
      "-d",
      "-t",
      pane,
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    );
    const startingFirst = first.emit(start);
    vi.stubEnv("TMUX_PANE", split);
    const second = runtime({ name: "two" });
    await Promise.all([startingFirst, second.emit(start)]);
    const winner = await name();
    expect(["one", "two"]).toContain(winner);
    const loser = winner === "one" ? second : first;
    const token = await option("@pi_naming_owner");
    await loser.emit({ type: "session_info_changed", name: "loser" });
    await loser.emit(shutdown);
    expect(await name()).toBe(winner);
    expect(await option("@pi_naming_owner")).toBe(token);
    await (winner === "one" ? first : second).emit(shutdown);
    expect(await option("@pi_naming_owner")).toBe("");
  });

  it("warns on tmux failure without rejecting native lifecycle events", async () => {
    const app = runtime();
    app.exec.mockResolvedValue({
      stdout: "",
      stderr: "server unavailable",
      code: 1,
      killed: false,
      truncated: false,
    });
    await expect(app.emit(start)).resolves.toBeUndefined();
    expect(app.notify).toHaveBeenCalledWith("Tmux naming: server unavailable", "warning");
    await expect(app.emit(shutdown)).resolves.toBeUndefined();
  });

  it.each(["rpc", "print", "json"] as const)("does nothing in %s mode", async (mode) => {
    const app = runtime({ name: "no effect", mode });
    await app.emit(start);
    await app.emit({ type: "session_info_changed", name: "no effect" });
    await app.emit(shutdown);
    expect(app.exec).not.toHaveBeenCalled();
  });

  it("does nothing outside tmux or inside a native child", async () => {
    vi.stubEnv("TMUX", "");
    const outside = runtime();
    await outside.emit(start);
    await outside.emit(shutdown);
    expect(outside.exec).not.toHaveBeenCalled();
    vi.stubEnv("TMUX", `${socket},0,0`);
    const child = withChildContext({ cwd: directory, agentDir: join(directory, "agent") }, () =>
      runtime(),
    );
    await child.emit(start);
    await child.emit({ type: "session_info_changed", name: "child" });
    await child.emit(shutdown);
    expect(child.exec).not.toHaveBeenCalled();
  });
});
