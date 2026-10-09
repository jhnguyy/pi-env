import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  const expectedCaseCount = 9;
  let caseStart = 0;
  const evidence: Record<string, unknown> = {
    scenario: "real Pi with session-manager in an isolated tmux server",
    repeat: "nub run test:e2e:session-manager:docker",
    expectedCaseCount,
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
  // Pi without session-manager. Restoration must forward the extension itself.
  const piBaseCommand = (...args: string[]) =>
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
      ...args.map(quote),
    ].join(" ");
  const piCommand = (...args: string[]) => piBaseCommand("-e", extension, ...args);
  const respawn = (...args: string[]) =>
    tmux("respawn-pane", "-t", windowId, "-c", join(root, "work"), piCommand(...args));
  const bound = (previous = "", name?: string) =>
    until(
      window,
      (state) =>
        state.sessionId !== "" &&
        state.sessionId !== previous &&
        state.ownerPid === panePid() &&
        state.name === (name ?? `pi-${state.sessionId.slice(-6)}`),
      "a complete window binding",
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
      entry.actual = { ...entry.actual, error: String(error) };
      try {
        entry.actual.screen = screen();
      } catch (captureError) {
        entry.actual.captureError = String(captureError);
      }
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

  beforeEach(() => {
    caseStart = cases.length;
  });

  afterEach((context) => {
    if (context.task.result?.state !== "fail") return;
    if (cases.length === caseStart) {
      cases.push({
        name: context.task.name,
        expected: { workflowAndCleanup: "complete" },
        verdict: "incomplete",
      });
    }
    for (const entry of cases.slice(caseStart)) {
      entry.verdict = "fail";
      entry.actual = { ...entry.actual, testErrors: context.task.result.errors };
    }
    if (artifactPath) saveEvidence();
  });

  beforeAll(async () => {
    const parent = process.env["PI_ENV_E2E_ARTIFACT_DIR"] || tmpdir();
    mkdirSync(parent, { recursive: true });
    const evidenceDir = mkdtempSync(join(parent, "pi-session-manager-e2e-"));
    // Hosts that mount the directory may run as a different UID than the container.
    chmodSync(evidenceDir, 0o755);
    artifactPath = join(evidenceDir, "result.json");
    saveEvidence();
    for (const path of [piCli, extension]) {
      if (!existsSync(path)) throw new Error(`Missing ${path}; run nub install and nub run build`);
    }
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
    const cleanupErrors: string[] = [];
    if (socket) {
      try {
        tmux("kill-server");
      } catch (error) {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String(error.stderr).trim()
            : "";
        const alreadyGone =
          /^no server running on /u.test(stderr) ||
          /^error connecting to .* \(No such file or directory\)$/u.test(stderr);
        if (!alreadyGone) cleanupErrors.push(String(error));
      }
    }
    try {
      if (root) rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    if (artifactPath) {
      evidence.cleanupErrors = cleanupErrors;
      evidence.status =
        cases.length === expectedCaseCount &&
        cases.every((entry) => entry.verdict === "pass") &&
        cleanupErrors.length === 0
          ? "pass"
          : "fail";
      saveEvidence();
    }
    if (cleanupErrors.length > 0)
      throw new Error(`Session-manager E2E cleanup failed: ${cleanupErrors.join("; ")}`);
  });

  it(
    "binds an unnamed session and labels the window with its session ID suffix",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await check(
        "unnamed bind",
        {
          labelled: true,
          automaticRename: "off",
          ownerIsPanePi: true,
        },
        async () => {
          respawn();
          const state = await bound();
          if (!state.ownerPid)
            throw new Error(`Binding has no owner PID: ${JSON.stringify(state)}`);
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
          if (!killed.sessionId || !killed.ownerPid) {
            throw new Error(`No complete pre-kill binding: ${JSON.stringify(killed)}`);
          }
          signalPi("SIGKILL");
          await exited();
          const staleTagRemained = option("@pi_session_id") === killed.sessionId;
          if (!staleTagRemained) {
            throw new Error(
              `Stale tag was not preserved after SIGKILL: ${JSON.stringify(window())}`,
            );
          }
          respawn();
          let enrollmentFailed = false;
          const state = await until(
            () => ({ state: window(), failed: screen().includes("enrollment failed") }),
            ({ state: current, failed }) =>
              failed ||
              (current.sessionId !== "" &&
                current.sessionId !== killed.sessionId &&
                current.ownerPid === panePid() &&
                labelled(current)),
            "reclaim enrollment outcome",
          ).then(({ state: current, failed }) => {
            enrollmentFailed = failed;
            return current;
          });
          return {
            ...state,
            killedSessionId: killed.sessionId,
            staleTagRemained,
            rebound: state.sessionId !== "" && state.sessionId !== killed.sessionId,
            labelled: labelled(state),
            enrollmentFailed,
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
              reportsCause: screen().includes("WindowBindingConflict"),
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
    "arbitrates concurrent real Pi reclaimers and releases without deadlock",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await clearPane();
      let second = "";
      try {
        await check(
          "concurrent dead-owner reclaim",
          { oneOwner: true, loserRejected: true, loserPreservedOwner: true, released: true },
          async () => {
            respawn();
            await bound();
            signalPi("SIGKILL");
            await exited();
            const first = format("#{pane_id}");
            second = tmux(
              "split-window",
              "-d",
              "-P",
              "-F",
              "#{pane_id}",
              "-t",
              first,
              "-c",
              join(root, "work"),
              piCommand(),
            );
            respawn();
            const panes = [first, second];
            const pid = (pane: string) => tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
            const capture = (pane: string) => tmux("capture-pane", "-p", "-t", pane);
            await until(
              () => panes.some((pane) => capture(pane).includes("enrollment failed")),
              Boolean,
              "one rejected reclaimer",
            );
            const owner = option("@pi_session_pid");
            const winner = panes.find((pane) => pid(pane) === owner)!;
            const loser = panes.find((pane) => pane !== winner)!;
            const oneOwner = panes.filter((pane) => pid(pane) === owner).length === 1;
            const loserRejected = capture(loser).includes("enrollment failed");
            const stop = async (pane: string) => {
              process.kill(positivePid(pid(pane)), "SIGTERM");
              await until(
                () => tmux("display-message", "-p", "-t", pane, "#{pane_dead}"),
                (dead) => dead === "1",
                "reclaimer shutdown",
              );
            };
            await stop(loser);
            const loserPreservedOwner = option("@pi_session_pid") === owner;
            await stop(winner);
            return {
              oneOwner,
              loserRejected,
              loserPreservedOwner,
              released: option("@pi_session_id") === "" && option("@pi_session_pid") === "",
            };
          },
        );
      } finally {
        if (second) tmux("kill-pane", "-t", second);
        await clearPane();
      }
    },
  );

  it(
    "adopts an ownerless legacy tag and records the Pi owner",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await clearPane();
      try {
        await check(
          "ownerless legacy tag adoption",
          {
            sessionId: "legacy-session",
            ownerIsPanePi: true,
            labelled: true,
            enrollmentFailed: false,
          },
          async () => {
            tmux("set-option", "-w", "-t", windowId, "@pi_session_id", "legacy-session");
            tmux("set-option", "-w", "-u", "-t", windowId, "@pi_session_pid");
            respawn("--session-id", "legacy-session");
            const state = await until(
              window,
              (current) =>
                (current.ownerPid === panePid() && labelled(current)) ||
                screen().includes("enrollment failed"),
              "ownerless tag adoption outcome",
            );
            return {
              ...state,
              ownerIsPanePi: state.ownerPid === panePid(),
              labelled: labelled(state),
              enrollmentFailed: screen().includes("enrollment failed"),
            };
          },
        );
      } finally {
        if (format("#{pane_dead}") === "0") {
          signalPi("SIGTERM");
          await exited();
        }
        tmux("set-option", "-w", "-u", "-t", windowId, "@pi_session_id");
        tmux("set-option", "-w", "-u", "-t", windowId, "@pi_session_pid");
      }
    },
  );

  it(
    "keeps a same-ID live owner when a second Pi enrolls and exits",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await clearPane();
      let contender = "";
      try {
        await check(
          "same-ID exclusive live ownership",
          {
            rejected: true,
            ownerPreservedWhileLive: true,
            tagPreservedWhileLive: true,
            renameRejected: true,
            namePreserved: true,
            preservedAfterExit: true,
          },
          async () => {
            respawn();
            const incumbent = await bound();
            contender = tmux(
              "split-window",
              "-d",
              "-P",
              "-F",
              "#{pane_id}",
              "-t",
              windowId,
              "-c",
              join(root, "work"),
              piCommand("--session-id", incumbent.sessionId),
            );
            const contenderScreen = () => tmux("capture-pane", "-p", "-t", contender);
            await until(
              contenderScreen,
              (text) => text.includes("enrollment failed"),
              "same-ID contender rejection",
            );
            const rejected = contenderScreen().includes("enrollment failed");
            const ownerPreservedWhileLive = option("@pi_session_pid") === incumbent.ownerPid;
            const tagPreservedWhileLive = option("@pi_session_id") === incumbent.sessionId;
            tmux("send-keys", "-t", contender, "-l", "/name contender-label");
            tmux("send-keys", "-t", contender, "Enter");
            await until(
              contenderScreen,
              (text) => text.includes("Tmux window rename failed"),
              "same-ID contender rename rejection",
            );
            const renameRejected = contenderScreen().includes("WindowBindingConflict");
            const namePreserved = format("#{window_name}") === incumbent.name;
            const pid = tmux("display-message", "-p", "-t", contender, "#{pane_pid}");
            process.kill(positivePid(pid), "SIGTERM");
            await until(
              () => tmux("display-message", "-p", "-t", contender, "#{pane_dead}"),
              (dead) => dead === "1",
              "contender shutdown",
            );
            return {
              rejected,
              ownerPreservedWhileLive,
              tagPreservedWhileLive,
              renameRejected,
              namePreserved,
              preservedAfterExit:
                option("@pi_session_pid") === incumbent.ownerPid &&
                option("@pi_session_id") === incumbent.sessionId,
            };
          },
        );
      } finally {
        if (contender) tmux("kill-pane", "-t", contender);
        signalPi("SIGTERM");
        await exited();
      }
    },
  );

  it(
    "keeps an explicit session name on the window after release",
    { timeout: STEP_TIMEOUT_MS },
    async () => {
      await check(
        "explicit name",
        {
          boundName: "quiet pine; $(touch nope)",
          releasedName: "quiet pine; $(touch nope)",
          sessionId: "",
          noShellExecution: true,
        },
        async () => {
          const name = "quiet pine; $(touch nope)";
          respawn("--name", name);
          const state = await bound("", name);
          signalPi("SIGTERM");
          await exited();
          return {
            ...window(),
            boundName: state.name,
            releasedName: format("#{window_name}"),
            noShellExecution: !existsSync(join(root, "work", "nope")),
          };
        },
      );
    },
  );

  it(
    "keeps duplicate display names targeted by session ID across rename, release, and coordinator restoration",
    { timeout: STEP_TIMEOUT_MS * 2 },
    async () => {
      await clearPane();
      const firstWindow = windowId;
      let secondWindow = "";
      const work = join(root, "duplicate work");
      mkdirSync(work);
      const launch = (...args: string[]) =>
        tmux("respawn-pane", "-t", windowId, "-c", work, piCommand(...args));
      const restoredWindows: string[] = [];
      const lineWith = (text: string, ...parts: string[]) =>
        text.split("\n").find((line) => parts.every((part) => line.includes(part)));
      let completed = false;
      try {
        await check(
          "duplicate display names",
          {
            distinctIds: true,
            duplicateStart: true,
            duplicateRename: true,
            duplicateAdopt: true,
            statusHasId: true,
            targetedRelease: true,
            targetedRestore: true,
            restoredBindingsLive: true,
            restoreOutcomesSucceeded: true,
            closedDuplicateNotRestored: true,
          },
          async () => {
            launch("--name", "shared-label");
            const first = await bound("", "shared-label");
            secondWindow = tmux(
              "new-window",
              "-d",
              "-P",
              "-F",
              "#{window_id}",
              "-t",
              "e2e:",
              "sleep 600",
            );
            windowId = secondWindow;
            tmux("set-option", "-w", "-t", windowId, "remain-on-exit", "on");
            await clearPane();
            launch("--name", "shared-label");
            const second = await bound("", "shared-label");
            const duplicateStart = first.name === "shared-label" && second.name === first.name;
            const command = (text: string) => {
              tmux("send-keys", "-t", windowId, "-l", text);
              tmux("send-keys", "-t", windowId, "Enter");
            };
            command("/name temporary-label");
            await until(window, (state) => state.name === "temporary-label", "temporary rename");
            command("/name shared-label");
            const renamed = await until(
              window,
              (state) => state.name === first.name,
              "duplicate rename",
            );
            command("/session-status");
            // Earlier /name commands leave the name on screen, so require one line with both.
            const statusLine = lineWith(
              await until(
                screen,
                (text) => lineWith(text, first.name, second.sessionId) !== undefined,
                "status with the name beside the full session ID",
              ),
              first.name,
              second.sessionId,
            );
            const statusHasId = statusLine !== undefined;
            signalPi("SIGTERM");
            await exited();
            const released = window();
            const adoptedId = "12345678-1234-4123-8123-123456789abc";
            const adoptedFile = join(root, "adopt-duplicate.jsonl");
            writeFileSync(
              adoptedFile,
              `${JSON.stringify({
                type: "session",
                version: 3,
                id: adoptedId,
                cwd: work,
                timestamp: new Date().toISOString(),
              })}\n`,
            );
            launch("--session", adoptedFile, "--name", "shared-label");
            await until(
              screen,
              (text) => text.includes("shared-label"),
              "materialized session startup",
            );
            command("/session-adopt");
            const adopted = await bound("", "shared-label");
            command("/session-done");
            await exited();
            windowId = firstWindow;
            const preserved = window();
            signalPi("SIGTERM");
            await exited();
            windowId = secondWindow;
            const wrapper = join(root, "duplicate pi");
            writeFileSync(
              wrapper,
              `#!/bin/sh\nexport XDG_RUNTIME_DIR=${quote(join(root, "runtime"))}\nexec ${piBaseCommand()} "$@"\n`,
              { mode: 0o700 },
            );
            const start = join(repoRoot, ".pi/extensions/session-manager/dist/start.js");
            tmux(
              "respawn-pane",
              "-t",
              windowId,
              "-c",
              work,
              [
                "env",
                `PI_CODING_AGENT_DIR=${quote(join(root, "agent"))}`,
                `XDG_RUNTIME_DIR=${quote(join(root, "runtime"))}`,
                "PI_OFFLINE=1",
                `PI_ENV_NODE_BIN=${quote(process.execPath)}`,
                `PI_ENV_REAL_PI_ENTRY=${quote(piCli)}`,
                `PI_ENV_PI_WRAPPER=${quote(wrapper)}`,
                `PI_ENV_SESSION_MANAGER_EXTENSION=${quote(extension)}`,
                quote(process.execPath),
                quote(start),
              ].join(" "),
            );
            await until(
              screen,
              (text) => text.includes("Workspace restore complete."),
              "coordinator restoration",
            );
            const summary = screen();
            const restoredBindings = tmux(
              "list-windows",
              "-t",
              "e2e:",
              "-F",
              "#{window_id} #{@pi_session_id} #{window_name}",
            ).split("\n");
            const restoredWindow = async (id: string) => {
              const line = restoredBindings.find((item) => item.split(" ")[1] === id);
              if (!line) throw new Error(`No restored window for ${id}`);
              const target = line.split(" ")[0];
              restoredWindows.push(target);
              windowId = target;
              const state = await until(
                () => ({ ...window(), panePid: panePid(), dead: format("#{pane_dead}") }),
                (current) => current.dead === "0" && current.ownerPid === current.panePid,
                `a live owner for restored session ${id}`,
              );
              return { ...state, live: true };
            };
            const restored = await restoredWindow(second.sessionId);
            const stillFirst = await restoredWindow(first.sessionId);
            // Each outcome line must name the session and report success, not merely mention it.
            const outcome = (id: string) => lineWith(summary, first.name, id)?.trim() ?? "";
            const succeeded = (line: string) =>
              line.startsWith("\u2713") && /\s(restored|active)$/u.test(line);
            const outcomes = [outcome(first.sessionId), outcome(second.sessionId)];
            return {
              first,
              second,
              renamed,
              released,
              preserved,
              restored,
              stillFirst,
              distinctIds: first.sessionId !== second.sessionId,
              adopted,
              duplicateAdopt: adopted.sessionId === adoptedId && adopted.name === first.name,
              duplicateStart,
              duplicateRename:
                renamed.name === first.name && renamed.sessionId === second.sessionId,
              statusHasId,
              targetedRelease:
                released.sessionId === "" &&
                released.ownerPid === "" &&
                preserved.sessionId === first.sessionId &&
                preserved.ownerPid === first.ownerPid,
              targetedRestore:
                restored.sessionId === second.sessionId &&
                restored.name === first.name &&
                stillFirst.sessionId === first.sessionId &&
                stillFirst.name === first.name &&
                restored.ownerPid !== stillFirst.ownerPid,
              restoredBindingsLive: restored.live && stillFirst.live,
              outcomes,
              restoreOutcomesSucceeded:
                outcomes.every(succeeded) && summary.includes("2 active, 0 failed"),
              closedDuplicateNotRestored:
                !summary.includes(adoptedId) &&
                restoredBindings.every((line) => line.split(" ")[1] !== adoptedId),
              summary,
            };
          },
        );
        completed = true;
      } finally {
        // Best-effort teardown must not replace the workflow's own failure.
        const cleanupErrors: string[] = [];
        const stop = async (target: string, kill: boolean) => {
          try {
            windowId = target;
            if (format("#{pane_dead}") === "0") {
              tmux("set-option", "-w", "-t", target, "remain-on-exit", "on");
              signalPi("SIGTERM");
              await exited();
            }
            if (kill) tmux("kill-window", "-t", target);
          } catch (error) {
            cleanupErrors.push(`${target}: ${String(error)}`);
          }
        };
        for (const target of restoredWindows) await stop(target, true);
        if (secondWindow) await stop(secondWindow, true);
        await stop(firstWindow, false);
        windowId = firstWindow;
        if (cleanupErrors.length > 0) {
          evidence.duplicateNameCleanupErrors = cleanupErrors;
          saveEvidence();
          if (completed) throw new Error(`Cleanup failed: ${cleanupErrors.join("; ")}`);
        }
      }
    },
  );
});
