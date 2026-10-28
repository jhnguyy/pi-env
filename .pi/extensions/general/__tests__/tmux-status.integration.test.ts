import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  Theme,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import general from "../index";
import type { StatusState } from "../status";
import { TmuxStatus } from "../tmux-status";

const execute = promisify(execFile);
const palette: Record<StatusState, string> = {
  idle: "colour8",
  running: "#123456",
  done: "#345678",
  error: "colour196",
};
const glyphs = { idle: "○", done: "✓", error: "✗" };

// Native Pi drives lifecycle events; only inference and the terminal UI adapter are
// local fixtures. Transport scenarios below drive the public transport directly.
// This does not exercise an actual model service or the interactive terminal renderer.
class TmuxFixture {
  readonly socket: string;
  readonly observations: unknown[] = [];
  readonly clients: { child: ChildProcess; closed: Promise<void> }[] = [];
  readonly transports: TmuxStatus[] = [];
  readonly sessions: AgentSession[] = [];
  pane = "";
  window = "";
  constructor(readonly root: string) {
    this.socket = join(root, "tmux.sock");
  }

  async command(...args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execute("tmux", ["-S", this.socket, ...args], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TMUX: "", TMUX_PANE: "" },
      });
      this.observations.push({ command: args, stdout, stderr });
      return stdout.trim();
    } catch (error) {
      this.observations.push({ command: args, error: String(error) });
      throw error;
    }
  }

  async start(): Promise<void> {
    const ids = await this.command(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "status-test",
      "-P",
      "-F",
      "#{pane_id}|#{window_id}",
      "sleep 300",
    );
    [this.pane, this.window] = ids.split("|") as [string, string];
    await this.command("set-option", "-g", "status", "off");
    this.observations.push({ tmuxVersion: (await execute("tmux", ["-V"])).stdout.trim() });
  }

  transport(pane = this.pane): TmuxStatus {
    const transport = new TmuxStatus(pane, { socketPath: this.socket });
    this.transports.push(transport);
    return transport;
  }

  async paneValue(pane = this.pane): Promise<string> {
    return this.command("display-message", "-p", "-t", pane, "#{@pi_agent_pane_status}");
  }
  async indicator(): Promise<string> {
    return this.command("display-message", "-p", "-t", this.window, "#{@pi_agent_status}");
  }
  async client(session: string): Promise<void> {
    const count = this.clients.length + 1;
    const child = spawn("tmux", ["-S", this.socket, "-C", "attach-session", "-t", session], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMUX: "", TMUX_PANE: "" },
    });
    this.clients.push({ child, closed: new Promise((resolve) => child.once("close", resolve)) });
    child.stdout?.resume();
    child.stderr?.resume();
    await expect
      .poll(
        async () => {
          const output = await this.command("list-clients", "-F", "#{client_name}");
          return output.split("\n").filter(Boolean).length;
        },
        { timeout: 7_000 },
      )
      .toBe(count);
  }

  async cleanup(): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      await this.command(
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}|#{window_id}|#{@pi_agent_owner}|#{@pi_agent_pane_status}|#{@pi_agent_status}",
      );
    } catch (error) {
      this.observations.push({ finalSnapshotError: String(error) });
    }
    for (const session of this.sessions) {
      for (const release of [
        () => session.abort(),
        () => session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
        () => session.dispose(),
      ]) {
        try {
          await Promise.resolve(release());
        } catch (error) {
          failures.push(String(error));
        }
      }
    }
    for (const transport of this.transports) {
      try {
        await transport.close();
      } catch (error) {
        failures.push(String(error));
      }
    }
    for (const { child, closed } of this.clients) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      } catch (error) {
        failures.push(String(error));
      }
    }
    try {
      await this.command("kill-server");
    } catch (error) {
      failures.push(String(error));
    }
    return failures;
  }
}

async function fixture(): Promise<TmuxFixture> {
  const parent = process.env.PI_ENV_TMUX_STATUS_ARTIFACT_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "pi-tmux-status-"));
  const f = new TmuxFixture(root);
  const scenario = expect.getState().currentTestName;
  onTestFinished(async ({ task }) => {
    const cleanupFailures = await f.cleanup();
    vi.unstubAllEnvs();
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          evidenceBoundary:
            "Real isolated tmux, native Pi, local faux provider and UI adapter; no remote inference or terminal renderer",
          reproduce:
            "nub run test:integration .pi/extensions/general/__tests__/tmux-status.integration.test.ts",
          inputs: {
            socket: f.socket,
            config: "/dev/null",
            node: process.version,
            credentials: "none; isolated empty auth path",
          },
          expected: {
            scenario,
            palette,
            paneFormat: "state|seen(0/1)|color|frame(0-9)",
            assertions: ".pi/extensions/general/__tests__/tmux-status.integration.test.ts",
          },
          actual: f.observations,
          result: {
            ...task.result,
            state: cleanupFailures.length ? "fail" : task.result?.state,
            errors: task.result?.errors ?? [],
            assertions: expect.getState().assertionCalls,
            cleanupFailures,
          },
        },
        null,
        2,
      ),
    );
    console.info(`tmux status evidence: ${root}`);
    expect(cleanupFailures, "all fixture cleanup steps complete").toEqual([]);
  });
  await f.start();
  return f;
}

function indicator(state: StatusState, seen = false): string {
  const glyph = state === "running" ? "⠋" : glyphs[state];
  return `#[push-default]#[fg=${palette[state]},nobold,nodim,${seen ? "dim" : "bold"}]${glyph}#[pop-default]`;
}

// Resolve a real Theme, including indexed and RGB colors, without global theme state.
function theme(accent = "#123456"): Theme {
  return new Theme(
    {
      accent,
      success: "#345678",
      error: 196,
      muted: 8,
      text: "#eeeeee",
      thinkingXhigh: "#ffffff",
    } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
}

async function nativeSession(f: TmuxFixture, mode: "tui" | "print" | "rpc" = "tui", retry = false) {
  f.observations.push({ nativeInput: { mode, retry } });
  vi.stubEnv("TMUX", `${f.socket},0,0`);
  vi.stubEnv("TMUX_PANE", f.pane);
  const provider = fauxProvider({
    provider: `tmux-status-${f.sessions.length}`,
    tokenSize: { min: 4, max: 4 },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
    retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
  });
  const agentDir = join(f.root, `agent-${f.sessions.length}`);
  await mkdir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "empty-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: f.root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider(provider.provider), general],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: f.root,
    agentDir,
    modelRuntime,
    model: provider.getModel(),
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(f.root),
    tools: [],
  });
  f.sessions.push(session);
  let currentTheme = theme();
  const uiCalls: string[] = [];
  // The adapter is the external UI seam, not a substitute ExtensionAPI or event runner.
  const liveTheme = theme();
  Object.defineProperty(liveTheme, "colors", { get: () => currentTheme.colors });
  const ui = new Proxy({ theme: liveTheme } as ExtensionUIContext, {
    get(_target, property) {
      if (property === "theme") return liveTheme;
      return () => {
        uiCalls.push(String(property));
        throw new Error(`Unexpected UI operation ${String(property)}`);
      };
    },
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode,
    uiContext: ui,
    onError: (error) => {
      errors.push(error);
      f.observations.push({ extensionError: error });
    },
  });
  return {
    session,
    provider,
    uiCalls,
    errors,
    setTheme: (value: Theme) => {
      currentTheme = value;
    },
  };
}

// A provider-side gate gives the test an observable running boundary without
// timing assumptions. Cancellation resolves through the provider's real signal.
function responseGate(): { step: FauxResponseStep; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: FauxResponseStep = async (_context, options) => {
    enter();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      void ready.then(resolve);
    });
    return fauxAssistantMessage("controlled local response");
  };
  return { step, entered, release };
}

describe("tmux status integration (real isolated server)", () => {
  it.each([false, true])(
    "aggregates running > error > done > idle despite layout order (linked=%s)",
    async (linked) => {
      const f = await fixture();
      if (linked) {
        await f.command("new-session", "-d", "-s", "linked", "sleep 300");
        await f.command("link-window", "-s", f.window, "-t", "linked:1");
      }
      const panes = [f.pane];
      for (let i = 0; i < 3; i++)
        panes.push(
          await f.command(
            "split-window",
            "-d",
            "-t",
            f.window,
            "-P",
            "-F",
            "#{pane_id}",
            "sleep 300",
          ),
        );
      const states: StatusState[] = ["idle", "done", "error", "running"];
      const owners = panes.map((pane) => f.transport(pane));
      for (let i = 0; i < states.length; i++) await owners[i].update(states[i], palette[states[i]]);
      for (let i = states.length - 1; i >= 0; i--) {
        expect(await f.indicator(), `priority winner ${states[i]}`).toBe(indicator(states[i]));
        await owners[i].close();
        expect(await f.paneValue(panes[i]), "closed pane metadata removed").toBe("");
      }
      expect(await f.indicator(), "last owner clears window indicator").toBe("");
    },
  );

  it("keeps a replacement owner's metadata safe from stale updates and cleanup", async () => {
    const f = await fixture();
    const old = f.transport();
    await old.update("error", palette.error);
    const replacement = f.transport();
    await replacement.update("done", palette.done);
    const owner = await f.command("display-message", "-p", "-t", f.pane, "#{@pi_agent_owner}");
    await old.update("running", palette.running);
    await old.close();
    expect(await f.paneValue(), "old update/close cannot overwrite replacement").toBe(
      "done|0|#345678|0",
    );
    expect(
      await f.command("display-message", "-p", "-t", f.pane, "#{@pi_agent_owner}"),
      "replacement retains ownership",
    ).toBe(owner);
    await replacement.close();
    await replacement.update("running", palette.running);
    expect(await f.indicator(), "closed owner cannot rearm").toBe("");
  });

  it("acknowledges viewing by any real client without animation or theme rearming unseen", async () => {
    const f = await fixture();
    await f.command("new-session", "-d", "-s", "elsewhere", "sleep 300");
    await f.client("elsewhere");
    const transport = f.transport();
    await transport.update("running", palette.running);
    expect(await f.indicator(), "unviewed window is bold").toBe(indicator("running"));
    await f.client("status-test");
    await transport.update("running", palette.running);
    const viewed = await f.paneValue();
    expect(viewed, "second client acknowledges running").toBe("running|1|#123456|1");
    expect(await f.indicator()).toContain(",dim]");
    await f.command("switch-client", "-t", "elsewhere");
    await expect
      .poll(async () => (await f.command("list-clients", "-F", "#{window_id}")).split("\n"), {
        timeout: 7_000,
      })
      .not.toContain(f.window);
    await transport.update("running", "#abcdef");
    expect(await f.paneValue(), "animation/theme preserve acknowledgement").toBe(
      "running|1|#abcdef|2",
    );
    expect(await f.indicator()).toContain("fg=#abcdef,nobold,nodim,dim]");
    await transport.update("done", palette.done);
    expect(await f.indicator(), "new state rearms unseen").toBe(indicator("done"));
  });

  it("rearms unseen completion after coalesced transitions return to the same state", async () => {
    const f = await fixture();
    await f.command("new-session", "-d", "-s", "elsewhere", "sleep 300");
    await f.client("status-test");
    const transport = f.transport();
    await transport.update("done", palette.done, 0);
    expect(await f.indicator(), "previous completion is viewed").toBe(indicator("done", true));
    await f.command("switch-client", "-t", "elsewhere");
    // Session polling can coalesce done -> running -> done into one write.
    await transport.update("done", palette.done, 2);
    expect(await f.indicator(), "new completion is unseen").toBe(indicator("done"));
  });

  it("uses native Pi for errors, recovery, cancellation, theme polling and shutdown", async () => {
    const f = await fixture();
    const n = await nativeSession(f);
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);
    await expect.poll(() => f.indicator(), { timeout: 7_000 }).toBe(indicator("idle"));

    const gate = responseGate();
    n.provider.setResponses([gate.step]);
    const run = n.session.prompt("Complete a gated local request.");
    await gate.entered;
    try {
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#123456\|[0-9]$/);
      await expect
        .poll(() => f.indicator(), { timeout: 7_000 })
        .toMatch(
          /^#\[push-default\]#\[fg=#123456,nobold,nodim,bold\][⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]#\[pop-default\]$/,
        );
      n.setTheme(theme("#abcdef"));
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#abcdef\|[0-9]$/);
    } finally {
      gate.release();
      await run;
    }
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^done\|[01]\|#345678\|[0-9]$/);

    n.provider.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "deterministic fixture failure",
      }),
    ]);
    await n.session.prompt("Return a deterministic failure.");
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^error\|[01]\|colour196\|[0-9]$/);
    await expect.poll(() => f.indicator(), { timeout: 7_000 }).toBe(indicator("error"));
    n.provider.setResponses([fauxAssistantMessage("recovered")]);
    await n.session.prompt("Recover from that failure.");
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^done\|[01]\|#345678\|[0-9]$/);

    const cancel = responseGate();
    n.provider.setResponses([cancel.step]);
    const cancelled = n.session.prompt("Wait for cancellation.");
    await cancel.entered;
    try {
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#abcdef\|[0-9]$/);
      await n.session.abort();
      await cancelled;
    } finally {
      cancel.release();
    }
    expect(n.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);

    expect(n.uiCalls, "no extension UI modifications").toEqual([]);
    expect(n.errors, "no native extension errors").toEqual([]);
    await n.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(await f.paneValue(), "shutdown drains pane metadata").toBe("");
    expect(await f.indicator(), "shutdown drains window metadata").toBe("");
  }, 30_000);

  it("keeps native automatic recovery running until the retry settles", async () => {
    const f = await fixture();
    const n = await nativeSession(f, "tui", true);
    const retryEvents: string[] = [];
    n.session.subscribe((event) => {
      if (event.type.startsWith("auto_retry_")) retryEvents.push(event.type);
    });
    const gate = responseGate();
    n.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit fixture" }),
      gate.step,
    ]);
    const run = n.session.prompt("Recover from a transient local provider error.");
    await gate.entered;
    try {
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#123456\|[0-9]$/);
      expect(retryEvents, "native retry really occurred").toContain("auto_retry_start");
    } finally {
      gate.release();
      await run;
    }
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^done\|[01]\|#345678\|[0-9]$/);
    expect(n.provider.state.callCount, "retry consumed exactly two responses").toBe(2);
    expect(n.errors, "no native extension errors").toEqual([]);
  });

  it("keeps cancelled overflow recovery idle despite the preceding response error", async () => {
    const f = await fixture();
    const n = await nativeSession(f);
    n.provider.setResponses([fauxAssistantMessage("history ".repeat(200))]);
    await n.session.prompt("Create synthetic history for recovery compaction.");
    n.session.setAutoCompactionEnabled(true);
    const gate = responseGate();
    n.provider.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "maximum context length is 16384 tokens",
      }),
      gate.step,
    ]);
    const run = n.session.prompt("Trigger context overflow recovery.");
    await gate.entered;
    try {
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#123456\|[0-9]$/);
      n.session.abortCompaction();
      await run;
    } finally {
      gate.release();
    }
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);
    expect(n.errors, "no native extension errors").toEqual([]);
  });

  it("uses native manual compaction and resets status on a repeated session start", async () => {
    const f = await fixture();
    const n = await nativeSession(f);
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);
    // Real compaction consumes native conversation history and the local provider.
    n.provider.setResponses([fauxAssistantMessage("history ".repeat(200))]);
    await n.session.prompt("Create history for manual compaction.");
    const compactGate = responseGate();
    n.provider.setResponses([compactGate.step]);
    const compacting = n.session.compact("Summarize this synthetic conversation.");
    await compactGate.entered;
    try {
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^running\|[01]\|#123456\|[0-9]$/);
    } finally {
      compactGate.release();
      await compacting;
    }
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^done\|[01]\|#345678\|[0-9]$/);
    expect(n.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      true,
    );
    const previousOwner = await f.command(
      "display-message",
      "-p",
      "-t",
      f.pane,
      "#{@pi_agent_owner}",
    );
    // Public rebinding emits session_start again. This proves handler replacement,
    // not AgentSessionRuntime's separate session-file switching implementation.
    await n.session.bindExtensions({});
    await expect
      .poll(() => f.paneValue(), { timeout: 7_000 })
      .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);
    await expect
      .poll(
        async () => {
          const owner = await f.command(
            "display-message",
            "-p",
            "-t",
            f.pane,
            "#{@pi_agent_owner}",
          );
          return owner !== "" && owner !== previousOwner;
        },
        { timeout: 7_000, message: "session start claims a new owner" },
      )
      .toBe(true);
    expect(n.uiCalls, "no extension UI modifications").toEqual([]);
    expect(n.errors, "no native extension errors").toEqual([]);
    await n.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(await f.paneValue(), "shutdown drains pane metadata").toBe("");
    expect(await f.indicator(), "shutdown drains window metadata").toBe("");
  }, 30_000);

  it.each(["failure", "cancellation"] as const)(
    "settles native manual compaction %s",
    async (outcome) => {
      const f = await fixture();
      const n = await nativeSession(f);
      n.provider.setResponses([fauxAssistantMessage("history ".repeat(200))]);
      await n.session.prompt("Create synthetic history for compaction.");
      await expect
        .poll(() => f.paneValue(), { timeout: 7_000 })
        .toMatch(/^done\|[01]\|#345678\|[0-9]$/);
      if (outcome === "failure") {
        n.provider.setResponses([
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "fixture compaction failure",
          }),
        ]);
        await expect(n.session.compact("Summarize.")).rejects.toThrow();
        await expect
          .poll(() => f.paneValue(), { timeout: 7_000 })
          .toMatch(/^error\|[01]\|colour196\|[0-9]$/);
      } else {
        const gate = responseGate();
        n.provider.setResponses([gate.step]);
        const compacting = n.session.compact("Summarize.");
        // Attach the rejection observer before cancelling to avoid an unhandled rejection.
        const rejected = expect(compacting).rejects.toThrow();
        await gate.entered;
        try {
          await expect
            .poll(() => f.paneValue(), { timeout: 7_000 })
            .toMatch(/^running\|[01]\|#123456\|[0-9]$/);
          n.session.abortCompaction();
          await rejected;
        } finally {
          gate.release();
        }
        await expect
          .poll(() => f.paneValue(), { timeout: 7_000 })
          .toMatch(/^idle\|[01]\|colour8\|[0-9]$/);
      }
      expect(n.errors, "no native extension errors").toEqual([]);
    },
  );

  it.each(["print", "rpc"] as const)(
    "has no tmux or UI side effects in native %s mode",
    async (mode) => {
      const f = await fixture();
      const n = await nativeSession(f, mode);
      n.provider.setResponses([fauxAssistantMessage("non-interactive completion")]);
      const stdout = vi.spyOn(process.stdout, "write");
      try {
        await n.session.prompt("Complete without TUI effects.");
        expect(
          stdout.mock.calls.map(([value]) => String(value)),
          "non-TUI emits no terminal output",
        ).toEqual([]);
      } finally {
        stdout.mockRestore();
      }
      expect(await f.paneValue(), "non-TUI pane remains untouched").toBe("");
      expect(await f.indicator(), "non-TUI window remains untouched").toBe("");
      expect(n.uiCalls, "non-TUI UI remains untouched").toEqual([]);
      expect(n.errors, "no native extension errors").toEqual([]);
    },
  );
});
