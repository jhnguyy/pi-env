import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives real Pi with only session-manager loaded inside an isolated tmux server.
// Run in the container with `nub run test:e2e:session-manager:docker`.
const describeE2E = process.env["E2E"] === "1" ? describe : describe.skip;
const repoRoot = process.cwd();
const piCli = join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = join(repoRoot, ".pi/extensions/session-manager/dist/index.js");
const STEP_TIMEOUT_MS = 60_000;
const WAIT_MS = 20_000;

type Case = {
  name: string;
  expected: Record<string, unknown>;
  actual?: Record<string, unknown>;
  verdict: "pass" | "fail" | "incomplete";
};

// Launch Pi with the real Node binary and a minimal environment. Toolchain shims on PATH
// would otherwise run Pi as a child process, so the pane process would not be Pi.
const piEnv: Record<string, string> = { TERM: "xterm-256color" };
for (const key of ["HOME", "PATH", "USER", "LANG", "TMPDIR"]) {
  const value = process.env[key];
  if (value !== undefined) piEnv[key] = value;
}
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Guards against signalling pid 0, which targets the whole process group.
const positivePid = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Not a process ID: "${value}"`);
  return Number(value);
};

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let value = read();
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
    value = read();
  }
  return value;
}

describeE2E("session-manager in real tmux", () => {
  let root = "";
  let socket = "";
  let windowId = "";
  let artifactPath = "";
  const cases: Case[] = [];
  const evidence: Record<string, unknown> = {
    scenario: "real Pi with session-manager in an isolated tmux server",
    repeat: "nub run test:e2e:session-manager:docker",
    cases,
    status: "incomplete",
  };

  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: piEnv,
    }).trim();
  const option = (name: string) => tmux("show-options", "-w", "-q", "-v", "-t", windowId, name);
  const format = (value: string) => tmux("display-message", "-p", "-t", windowId, value);
  const screen = () => tmux("capture-pane", "-p", "-t", windowId);
  const window = () => ({
    sessionId: option("@pi_session_id"),
    ownerPid: option("@pi_session_pid"),
    name: format("#{window_name}"),
    automaticRename: option("automatic-rename") || "inherited",
  });
  const panePid = () => format("#{pane_pid}");
  const signalPi = (signal: NodeJS.Signals) => {
    if (format("#{pane_dead}") !== "0") throw new Error("No live Pi process in the pane");
    process.kill(positivePid(panePid()), signal);
  };
  const exited = () =>
    until(
      () => format("#{pane_dead}"),
      (dead) => dead === "1",
      "Pi to exit",
    );
  const clearPane = async () => {
    tmux("respawn-pane", "-k", "-t", windowId, "true");
    await exited();
  };
  const piCommand = (...args: string[]) =>
    [
      "env",
      `PI_CODING_AGENT_DIR=${quote(join(root, "agent"))}`,
      "PI_OFFLINE=1",
      quote(process.execPath),
      quote(piCli),
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      quote(extension),
      ...args.map(quote),
    ].join(" ");
  const respawn = (...args: string[]) =>
    tmux("respawn-pane", "-t", windowId, "-c", join(root, "work"), piCommand(...args));
  const bound = (previous = "") =>
    until(
      window,
      (state) => state.sessionId !== "" && state.sessionId !== previous,
      "a window binding",
    );
  const labelled = (state: { sessionId: string; name: string }) =>
    state.name === `pi-${state.sessionId.slice(-6)}`;

  async function check(
    name: string,
    expected: Record<string, unknown>,
    run: () => Promise<Record<string, unknown>>,
  ) {
    const entry: Case = { name, expected, verdict: "incomplete" };
    cases.push(entry);
    try {
      entry.actual = await run();
      expect(entry.actual).toMatchObject(expected);
      entry.verdict = "pass";
    } catch (error) {
      entry.verdict = "fail";
      entry.actual = { ...entry.actual, error: String(error), screen: screen() };
      throw error;
    } finally {
      saveEvidence();
    }
  }

  function saveEvidence() {
    const text = JSON.stringify(evidence, null, 2)
      .replaceAll(root, "<root>")
      .replaceAll(repoRoot, "<repo>");
    writeFileSync(artifactPath, `${text}\n`);
  }

  beforeAll(async () => {
    for (const path of [piCli, extension]) {
      if (!existsSync(path)) throw new Error(`Missing ${path}; run nub install and nub run build`);
    }
    const parent = process.env["PI_ENV_E2E_ARTIFACT_DIR"] || tmpdir();
    mkdirSync(parent, { recursive: true });
    artifactPath = join(mkdtempSync(join(parent, "pi-session-manager-e2e-")), "result.json");
    console.info(`Session-manager E2E evidence: ${artifactPath}`);
    root = mkdtempSync(join(tmpdir(), "smx-"));
    mkdirSync(join(root, "agent"));
    mkdirSync(join(root, "work"));
    socket = join(root, "tmux.sock");
    evidence.revision =
      process.env["PI_ENV_REVISION"] ??
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    evidence.tmux = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
    evidence.pi = execFileSync(process.execPath, [piCli, "--version"], {
      encoding: "utf8",
      env: piEnv,
    }).trim();
    tmux("new-session", "-d", "-s", "e2e", "-x", "160", "-y", "40", "sleep 600");
    windowId = tmux("display-message", "-p", "-t", "e2e:", "#{window_id}");
    tmux("set-option", "-w", "-t", windowId, "remain-on-exit", "on");
    await clearPane();
    saveEvidence();
  });

  afterAll(() => {
    if (artifactPath) {
      evidence.status = cases.every((entry) => entry.verdict === "pass") ? "pass" : "fail";
      saveEvidence();
    }
    if (socket) {
      try {
        tmux("kill-server");
      } catch {
        // The server is already gone.
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "binds an unnamed session and labels the window with its session ID suffix",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await check(
        "unnamed bind",
        { labelled: true, automaticRename: "off", ownerIsPanePi: true },
        async () => {
          respawn();
          const state = await bound();
          return {
            ...state,
            labelled: labelled(state),
            ownerIsPanePi: state.ownerPid === panePid(),
          };
        },
      );
    },
  );

  it(
    "reclaims the window after the owning Pi is killed",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await check(
        "reclaim after kill -9",
        { staleTagRemained: true, rebound: true, labelled: true, enrollmentFailed: false },
        async () => {
          const killed = window();
          signalPi("SIGKILL");
          await exited();
          const staleTagRemained = option("@pi_session_id") === killed.sessionId;
          respawn();
          const state = await bound(killed.sessionId).catch(() => window());
          await sleep(1_000);
          return {
            ...state,
            killedSessionId: killed.sessionId,
            staleTagRemained,
            rebound: state.sessionId !== killed.sessionId,
            labelled: labelled(state),
            enrollmentFailed: screen().includes("enrollment failed"),
          };
        },
      );
    },
  );

  it("releases the window when Pi exits gracefully", { timeout: STEP_TIMEOUT_MS }, async () => {
    await check(
      "graceful release",
      { sessionId: "", ownerPid: "", automaticRename: "inherited" },
      async () => {
        signalPi("SIGTERM");
        await exited();
        return window();
      },
    );
  });

  it(
    "refuses a window bound by a live process and reports the cause",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      let holder: ChildProcess | undefined;
      try {
        await clearPane();
        await check(
          "live owner conflict",
          { sessionId: "held-by-live-process", reportsCause: true },
          async () => {
            holder = spawn("sleep", ["60"], { stdio: "ignore" });
            tmux("set-option", "-w", "-t", windowId, "@pi_session_id", "held-by-live-process");
            tmux("set-option", "-w", "-t", windowId, "@pi_session_pid", `${holder.pid}`);
            respawn();
            await until(
              screen,
              (text) => text.includes("enrollment failed"),
              "the enrollment error",
            );
            return {
              ...window(),
              reportsCause: screen().includes(
                `WindowBindingConflict (windowId=${windowId}, existingSessionId=held-by-live-process)`,
              ),
            };
          },
        );
      } finally {
        holder?.kill();
        await clearPane();
        tmux("set-option", "-w", "-u", "-t", windowId, "@pi_session_id");
        tmux("set-option", "-w", "-u", "-t", windowId, "@pi_session_pid");
      }
    },
  );

  it(
    "keeps an explicit session name on the window after release",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await check(
        "explicit name",
        { boundName: "troubleshooting", releasedName: "troubleshooting", sessionId: "" },
        async () => {
          respawn("--name", "troubleshooting");
          const state = await bound();
          signalPi("SIGTERM");
          await exited();
          return { ...window(), boundName: state.name, releasedName: format("#{window_name}") };
        },
      );
    },
  );
});
