import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { TmuxStatus, type StatusPalette, type StatusState } from "../tmux-status";

const execute = promisify(execFile);
const palette: StatusPalette = {
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
  readonly clients: ChildProcess[] = [];
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
  async indicator(window = this.window): Promise<string> {
    return this.command("display-message", "-p", "-t", window, "#{@pi_agent_status}");
  }
  async check(label: string, expected: unknown, actual: unknown): Promise<void> {
    this.observations.push({ label, expected, actual });
    expect(actual, label).toEqual(expected);
  }

  async until(
    label: string,
    expected: string,
    read: () => Promise<string>,
    accepts = (s: string) => s === expected,
  ): Promise<string> {
    const deadline = Date.now() + 7_000;
    let actual = "";
    do {
      actual = await read();
      if (accepts(actual)) {
        this.observations.push({ label, expected, actual });
        return actual;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    this.observations.push({ label, expected, actual, watchdog: true });
    throw new Error(
      `${label}: expected ${expected}; actual ${JSON.stringify(actual)}; evidence ${this.root}`,
    );
  }

  async state(state: StatusState, color = palette[state]): Promise<string> {
    return this.until(
      `pane reaches ${state} with theme color`,
      `${state}|[01]|${color}|[0-9]`,
      () => this.paneValue(),
      (s) => {
        const p = s.split("|");
        return (
          p[0] === state &&
          p[2] === color &&
          /^[01]$/.test(p[1] ?? "") &&
          /^[0-9]$/.test(p[3] ?? "")
        );
      },
    );
  }

  async client(session: string): Promise<ChildProcess> {
    const count = this.clients.length + 1;
    const child = spawn("tmux", ["-S", this.socket, "-C", "attach-session", "-t", session], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMUX: "", TMUX_PANE: "" },
    });
    this.clients.push(child);
    child.stdout?.on("data", (data: Buffer) =>
      this.observations.push({ client: count, stdout: data.toString() }),
    );
    child.stderr?.on("data", (data: Buffer) =>
      this.observations.push({ client: count, stderr: data.toString() }),
    );
    await this.until("control client attached", String(count), async () => {
      const output = await this.command("list-clients", "-F", "#{client_name}");
      return String(output.split("\n").filter(Boolean).length);
    });
    return child;
  }

  async cleanup(): Promise<void> {
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
      try {
        await session.abort();
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      } catch (error) {
        failures.push(String(error));
      } finally {
        session.dispose();
      }
    }
    for (const transport of this.transports) {
      try {
        await transport.close();
      } catch (error) {
        failures.push(String(error));
      }
    }
    for (const client of this.clients) {
      try {
        if (client.exitCode !== null || client.signalCode !== null) continue;
        const exited = new Promise<void>((resolve) => client.once("close", () => resolve()));
        client.kill("SIGKILL");
        await exited;
      } catch (error) {
        failures.push(String(error));
      }
    }
    try {
      await this.command("kill-server");
    } catch (error) {
      failures.push(String(error));
    }
    this.observations.push({ cleanupFailures: failures });
    await writeFile(
      join(this.root, "evidence.json"),
      JSON.stringify(
        {
          evidenceBoundary:
            "Real disposable tmux, native Pi session lifecycle, registered local faux provider, UI adapter (no terminal renderer or remote inference)",
          reproduce:
            "nub run test:integration .pi/extensions/general/__tests__/tmux-status.integration.test.ts",
          inputs: {
            socket: this.socket,
            config: "/dev/null",
            palette,
            node: process.version,
            credentials: "none; isolated empty auth path",
          },
          observations: this.observations,
        },
        null,
        2,
      ),
    );
    console.info(`tmux status evidence: ${this.root}`);
    expect(failures, "fixture cleanup failures").toEqual([]);
  }
}

const fixtures: TmuxFixture[] = [];
afterEach(async () => {
  try {
    const results = await Promise.allSettled(
      fixtures.splice(0).map((fixture) => fixture.cleanup()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures, "all fixture cleanup steps complete").toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

async function fixture(): Promise<TmuxFixture> {
  const parent = process.env.PI_ENV_TMUX_STATUS_ARTIFACT_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "pi-tmux-status-"));
  const f = new TmuxFixture(root);
  f.observations.push({ scenario: expect.getState().currentTestName });
  fixtures.push(f);
  await f.start();
  return f;
}

function indicator(state: StatusState, seen = false, colors = palette): string {
  const glyph = state === "running" ? "⠋" : glyphs[state];
  return `#[push-default]#[fg=${colors[state]},nobold,nodim,${seen ? "dim" : "bold"}]${glyph}#[pop-default]`;
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
    extensionFactories: [
      (pi) => {
        pi.registerProvider(provider.provider);
        pi.on("session_start", (_event, ctx) => {
          f.observations.push({
            nativeStart: {
              mode: ctx.mode,
              pane: process.env.TMUX_PANE,
              socket: process.env.TMUX,
              colors: ctx.ui.theme.colors,
            },
          });
        });
      },
      general,
    ],
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
  session.subscribe((event) => {
    if (event.type !== "message_update") f.observations.push({ nativeEvent: event });
  });
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
      for (let i = 0; i < states.length; i++) await owners[i].update(states[i], palette);
      for (let i = states.length - 1; i >= 0; i--) {
        await f.check(`priority winner ${states[i]}`, indicator(states[i]), await f.indicator());
        await owners[i].close();
        await f.check("closed pane metadata removed", "", await f.paneValue(panes[i]));
      }
      await f.check("last owner clears window indicator", "", await f.indicator());
    },
  );

  it("keeps a replacement owner's metadata safe from stale updates and cleanup", async () => {
    const f = await fixture();
    const old = f.transport();
    await old.update("error", palette);
    const replacement = f.transport();
    await replacement.update("done", palette);
    const owner = await f.command("display-message", "-p", "-t", f.pane, "#{@pi_agent_owner}");
    await old.update("running", palette);
    await old.close();
    await f.check(
      "old update/close cannot overwrite replacement",
      "done|0|#345678|0",
      await f.paneValue(),
    );
    await f.check(
      "replacement retains ownership",
      owner,
      await f.command("display-message", "-p", "-t", f.pane, "#{@pi_agent_owner}"),
    );
    await replacement.close();
    await replacement.update("running", palette);
    await f.check("closed owner cannot rearm", "", await f.indicator());
  });

  it("acknowledges viewing by any real client without animation or theme rearming unseen", async () => {
    const f = await fixture();
    await f.command("new-session", "-d", "-s", "elsewhere", "sleep 300");
    await f.client("elsewhere");
    const transport = f.transport();
    await transport.update("running", palette);
    await f.check("unviewed window is bold", indicator("running"), await f.indicator());
    await f.client("status-test");
    await transport.update("running", palette);
    const viewed = await f.paneValue();
    await f.check("second client acknowledges running", "running|1|#123456|1", viewed);
    expect(await f.indicator()).toContain(",dim]");
    await f.command("switch-client", "-t", "elsewhere");
    await f.until(
      "all clients leave target",
      "no target clients",
      () => f.command("list-clients", "-F", "#{window_id}"),
      (s) => !s.split("\n").includes(f.window),
    );
    await transport.update("running", { ...palette, running: "#abcdef" });
    await f.check(
      "animation/theme preserve acknowledgement",
      "running|1|#abcdef|2",
      await f.paneValue(),
    );
    expect(await f.indicator()).toContain("fg=#abcdef,nobold,nodim,dim]");
    await transport.update("done", palette);
    await f.check("new state rearms unseen", indicator("done"), await f.indicator());
  });

  it("rearms unseen completion after coalesced transitions return to the same state", async () => {
    const f = await fixture();
    await f.command("new-session", "-d", "-s", "elsewhere", "sleep 300");
    await f.client("status-test");
    const transport = f.transport();
    await transport.update("done", palette, 0);
    await f.check("previous completion is viewed", indicator("done", true), await f.indicator());
    await f.command("switch-client", "-t", "elsewhere");
    // Session polling can coalesce done -> running -> done into one write.
    await transport.update("done", palette, 2);
    await f.check("new completion is unseen", indicator("done"), await f.indicator());
  });

  it("uses native Pi for errors, recovery, cancellation, theme polling and shutdown", async () => {
    const f = await fixture();
    const n = await nativeSession(f);
    await f.state("idle");
    await f.until("native idle indicator", indicator("idle"), () => f.indicator());

    const gate = responseGate();
    n.provider.setResponses([gate.step]);
    const run = n.session.prompt("Complete a gated local request.");
    await gate.entered;
    try {
      await f.state("running");
      await f.until(
        "native running indicator",
        "bold running spinner",
        () => f.indicator(),
        (s) =>
          /^#\[push-default\]#\[fg=#123456,nobold,nodim,bold\][⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]#\[pop-default\]$/.test(
            s,
          ),
      );
      n.setTheme(theme("#abcdef"));
      await f.state("running", "#abcdef");
    } finally {
      gate.release();
      await run;
    }
    await f.state("done");

    n.provider.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "deterministic fixture failure",
      }),
    ]);
    await n.session.prompt("Return a deterministic failure.");
    await f.state("error");
    await f.until("native failure indicator", indicator("error"), () => f.indicator());
    n.provider.setResponses([fauxAssistantMessage("recovered")]);
    await n.session.prompt("Recover from that failure.");
    await f.state("done");

    const cancel = responseGate();
    n.provider.setResponses([cancel.step]);
    const cancelled = n.session.prompt("Wait for cancellation.");
    await cancel.entered;
    try {
      await f.state("running", "#abcdef");
      await n.session.abort();
      await cancelled;
    } finally {
      cancel.release();
    }
    expect(n.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    await f.state("idle");

    await f.check("no extension UI modifications", [], n.uiCalls);
    await f.check("no native extension errors", [], n.errors);
    await n.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await f.check("shutdown drains pane metadata", "", await f.paneValue());
    await f.check("shutdown drains window metadata", "", await f.indicator());
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
      await f.state("running");
      await f.check("native retry really occurred", true, retryEvents.includes("auto_retry_start"));
    } finally {
      gate.release();
      await run;
    }
    await f.state("done");
    await f.check("retry consumed exactly two responses", 2, n.provider.state.callCount);
    await f.check("no native extension errors", [], n.errors);
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
      await f.state("running");
      n.session.abortCompaction();
      await run;
    } finally {
      gate.release();
    }
    await f.state("idle");
    await f.check("no native extension errors", [], n.errors);
  });

  it("uses native manual compaction and resets status on a repeated session start", async () => {
    const f = await fixture();
    const n = await nativeSession(f);
    await f.state("idle");
    // Real compaction consumes native conversation history and the local provider.
    n.provider.setResponses([fauxAssistantMessage("history ".repeat(200))]);
    await n.session.prompt("Create history for manual compaction.");
    const compactGate = responseGate();
    n.provider.setResponses([compactGate.step]);
    const compacting = n.session.compact("Summarize this synthetic conversation.");
    await compactGate.entered;
    try {
      await f.state("running");
    } finally {
      compactGate.release();
      await compacting;
    }
    await f.state("done");
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
    await f.state("idle");
    await f.until(
      "session start claims a new owner",
      "new owner token",
      () => f.command("display-message", "-p", "-t", f.pane, "#{@pi_agent_owner}"),
      (owner) => owner !== "" && owner !== previousOwner,
    );
    await f.check("no extension UI modifications", [], n.uiCalls);
    await f.check("no native extension errors", [], n.errors);
    await n.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await f.check("shutdown drains pane metadata", "", await f.paneValue());
    await f.check("shutdown drains window metadata", "", await f.indicator());
  }, 30_000);

  it.each(["failure", "cancellation"] as const)(
    "settles native manual compaction %s",
    async (outcome) => {
      const f = await fixture();
      const n = await nativeSession(f);
      n.provider.setResponses([fauxAssistantMessage("history ".repeat(200))]);
      await n.session.prompt("Create synthetic history for compaction.");
      await f.state("done");
      if (outcome === "failure") {
        n.provider.setResponses([
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "fixture compaction failure",
          }),
        ]);
        await expect(n.session.compact("Summarize.")).rejects.toThrow();
        await f.state("error");
      } else {
        const gate = responseGate();
        n.provider.setResponses([gate.step]);
        const compacting = n.session.compact("Summarize.");
        // Attach the rejection observer before cancelling to avoid an unhandled rejection.
        const rejected = expect(compacting).rejects.toThrow();
        await gate.entered;
        try {
          await f.state("running");
          n.session.abortCompaction();
          await rejected;
        } finally {
          gate.release();
        }
        await f.state("idle");
      }
      await f.check("no native extension errors", [], n.errors);
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
        await f.check(
          "non-TUI emits no terminal output",
          [],
          stdout.mock.calls.map(([value]) => String(value)),
        );
      } finally {
        stdout.mockRestore();
      }
      await f.check("non-TUI pane remains untouched", "", await f.paneValue());
      await f.check("non-TUI window remains untouched", "", await f.indicator());
      await f.check("non-TUI UI remains untouched", [], n.uiCalls);
      await f.check("no native extension errors", [], n.errors);
    },
  );
});
