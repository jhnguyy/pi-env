/**
 * Tests for OrchestratorManager — orch extension.
 *
 * Covers:
 *   - Manager instantiation / basic structure
 *   - runId generation is unique across instances
 *   - WorkerRecord construction after spawn
 *   - Label validation (pure, no live deps)
 *   - start / getStatus / spawn / cleanup flows via mock ExecFn
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { OrchestratorManager, buildPiCommand } from "../manager";
import { OrchError } from "../types";
import type { ExecFn } from "../types";

// ─── Mock ExecFn ─────────────────────────────────────────────

/** Returns a mock ExecFn that satisfies all tmux calls made by spawn/cleanup. */
function makeMockExec(paneId = "%42"): ExecFn {
  return async (cmd: string, args: string[]) => {
    // split-window → return the fake pane ID
    if (cmd === "tmux" && args.includes("split-window")) {
      return { stdout: paneId + "\n", stderr: "", code: 0 };
    }
    // select-pane → cosmetic, always ok
    if (cmd === "tmux" && args.includes("select-pane")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    // kill-pane → always ok
    if (cmd === "tmux" && args.includes("kill-pane")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    // fallback — succeed
    return { stdout: "", stderr: "", code: 0 };
  };
}

// ─── Env helpers ─────────────────────────────────────────────

let _orchDirsToClean: string[] = [];
let _busSessToClean: string[] = [];

function captureEnv() {
  return {
    PI_BUS_SESSION: process.env.PI_BUS_SESSION,
    PI_AGENT_ID: process.env.PI_AGENT_ID,
    TMUX: process.env.TMUX,
  };
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── Suite ───────────────────────────────────────────────────

describeIfEnabled("orch", "OrchestratorManager — instantiation", () => {
  it("constructs without throwing", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    expect(mgr).toBeDefined();
  });

  it("getStatus returns null before start()", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    expect(mgr.getStatus()).toBeNull();
  });
});

describeIfEnabled("orch", "OrchestratorManager — start()", () => {
  let saved: Record<string, string | undefined>;
  let orchDirs: string[] = [];
  let busSessions: string[] = [];

  beforeEach(() => {
    saved = captureEnv();
    orchDirs = [];
    busSessions = [];
  });

  afterEach(() => {
    for (const dir of orchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const sid of busSessions) {
      rmSync(`/tmp/pi-bus-${sid}`, { recursive: true, force: true });
    }
    restoreEnv(saved);
  });

  it("returns runId, orchDir, busSession", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const result = mgr.start();

    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(typeof result.orchDir).toBe("string");
    expect(result.orchDir.startsWith("/tmp/orch-")).toBe(true);
    expect(typeof result.busSession).toBe("string");

    orchDirs.push(result.orchDir);
    busSessions.push(result.busSession);
  });

  it("creates the orchDir on disk", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    expect(existsSync(orchDir)).toBe(true);
    orchDirs.push(orchDir);
    busSessions.push(busSession);
  });

  it("creates the bus session directory structure", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    expect(existsSync(`/tmp/pi-bus-${busSession}/channels`)).toBe(true);
    expect(existsSync(`/tmp/pi-bus-${busSession}/cursors`)).toBe(true);
    orchDirs.push(orchDir);
    busSessions.push(busSession);
  });

  it("sets PI_BUS_SESSION env var", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    expect(process.env.PI_BUS_SESSION).toBe(busSession);
    orchDirs.push(orchDir);
    busSessions.push(busSession);
  });

  it("sets PI_AGENT_ID to 'orch'", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    expect(process.env.PI_AGENT_ID).toBe("orch");
    orchDirs.push(orchDir);
    busSessions.push(busSession);
  });

  it("runIds are unique across multiple manager instances", () => {
    const mgr1 = new OrchestratorManager(makeMockExec());
    const mgr2 = new OrchestratorManager(makeMockExec());
    const r1 = mgr1.start();
    orchDirs.push(r1.orchDir);
    busSessions.push(r1.busSession);

    // cleanup mgr1 state so env doesn't interfere
    rmSync(r1.orchDir, { recursive: true, force: true });
    rmSync(`/tmp/pi-bus-${r1.busSession}`, { recursive: true, force: true });

    const r2 = mgr2.start();
    orchDirs.push(r2.orchDir);
    busSessions.push(r2.busSession);

    expect(r1.runId).not.toBe(r2.runId);
    expect(r1.busSession).not.toBe(r2.busSession);
  });

  it("runId looks like a short hex string", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { runId, orchDir, busSession } = mgr.start();
    expect(/^[a-f0-9]+$/.test(runId)).toBe(true);
    orchDirs.push(orchDir);
    busSessions.push(busSession);
  });

  it("throws RUN_ACTIVE if already running", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    expect(() => mgr.start()).toThrow(OrchError);
    try {
      mgr.start();
    } catch (e) {
      expect((e as OrchError).code).toBe("RUN_ACTIVE");
    }
  });

  it("throws INVALID_REPO for a non-git path", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    expect(() => mgr.start("/tmp")).toThrow(OrchError);
    try {
      mgr.start("/tmp");
    } catch (e) {
      expect((e as OrchError).code).toBe("INVALID_REPO");
    }
  });

  it("getStatus reflects state after start()", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { runId, orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    const status = mgr.getStatus();
    expect(status).not.toBeNull();
    expect(status!.runId).toBe(runId);
    expect(status!.orchDir).toBe(orchDir);
    expect(status!.busSession).toBe(busSession);
    expect(status!.workers).toHaveLength(0);
  });

  it("writes manifest to orchDir after start()", () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);
    expect(existsSync(`${orchDir}/.manifest.json`)).toBe(true);
  });
});

describeIfEnabled("orch", "OrchestratorManager — label validation", () => {
  let saved: Record<string, string | undefined>;
  let orchDirs: string[] = [];
  let busSessions: string[] = [];

  beforeEach(() => {
    saved = captureEnv();
    orchDirs = [];
    busSessions = [];
    // Provide TMUX so spawn doesn't fail at the tmux check
    process.env.TMUX = "test-session,0,0";
  });

  afterEach(() => {
    for (const dir of orchDirs) rmSync(dir, { recursive: true, force: true });
    for (const sid of busSessions) rmSync(`/tmp/pi-bus-${sid}`, { recursive: true, force: true });
    restoreEnv(saved);
  });

  async function withRun(
    fn: (mgr: OrchestratorManager) => Promise<void>,
  ): Promise<void> {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);
    await fn(mgr);
  }

  it("accepts valid labels", async () => {
    await withRun(async mgr => {
      for (const label of ["worker-1", "alpha", "a1b2c3", "scout"]) {
        const result = await mgr.spawn({ label, command: "echo hi" });
        expect(result.paneId).toContain(label);
      }
    });
  });

  it("rejects labels with uppercase letters", async () => {
    await withRun(async mgr => {
      await expect(mgr.spawn({ label: "Worker", command: "echo hi" })).rejects.toThrow(
        OrchError,
      );
    });
  });

  it("rejects labels with spaces", async () => {
    await withRun(async mgr => {
      await expect(mgr.spawn({ label: "has space", command: "echo hi" })).rejects.toThrow(
        OrchError,
      );
    });
  });

  it("rejects empty string label", async () => {
    await withRun(async mgr => {
      await expect(mgr.spawn({ label: "", command: "echo hi" })).rejects.toThrow(OrchError);
    });
  });

  it("rejects label longer than 64 chars", async () => {
    await withRun(async mgr => {
      const longLabel = "a".repeat(65);
      await expect(mgr.spawn({ label: longLabel, command: "echo hi" })).rejects.toThrow(
        OrchError,
      );
    });
  });

  it("rejects duplicate label in same run", async () => {
    await withRun(async mgr => {
      await mgr.spawn({ label: "scout", command: "echo first" });
      await expect(mgr.spawn({ label: "scout", command: "echo second" })).rejects.toThrow(
        OrchError,
      );
      try {
        await mgr.spawn({ label: "scout", command: "echo second" });
      } catch (e) {
        expect((e as OrchError).code).toBe("INVALID_LABEL");
      }
    });
  });
});

describeIfEnabled("orch", "OrchestratorManager — spawn()", () => {
  let saved: Record<string, string | undefined>;
  let orchDirs: string[] = [];
  let busSessions: string[] = [];

  beforeEach(() => {
    saved = captureEnv();
    orchDirs = [];
    busSessions = [];
    process.env.TMUX = "test-session,0,0";
  });

  afterEach(() => {
    for (const dir of orchDirs) rmSync(dir, { recursive: true, force: true });
    for (const sid of busSessions) rmSync(`/tmp/pi-bus-${sid}`, { recursive: true, force: true });
    restoreEnv(saved);
  });

  it("throws NO_ACTIVE_RUN before start()", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    await expect(mgr.spawn({ label: "scout", command: "echo hi" })).rejects.toThrow(OrchError);
    try {
      await mgr.spawn({ label: "scout", command: "echo hi" });
    } catch (e) {
      expect((e as OrchError).code).toBe("NO_ACTIVE_RUN");
    }
  });

  it("throws NOT_IN_TMUX when TMUX env is absent", async () => {
    delete process.env.TMUX;
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await expect(mgr.spawn({ label: "worker", command: "echo hi" })).rejects.toThrow(OrchError);
    try {
      await mgr.spawn({ label: "worker", command: "echo hi" });
    } catch (e) {
      expect((e as OrchError).code).toBe("NOT_IN_TMUX");
    }
  });

  it("returns paneId containing the runId and label", async () => {
    const mgr = new OrchestratorManager(makeMockExec("%99"));
    const { runId, orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    const result = await mgr.spawn({ label: "builder", command: "echo hi" });
    expect(result.paneId).toBe(`orch-${runId}-builder`);
  });

  it("returns no branch/worktreePath when no repo set", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    const result = await mgr.spawn({ label: "scout", command: "echo hi" });
    expect(result.branch).toBeUndefined();
    expect(result.worktreePath).toBeUndefined();
  });

  it("records worker in manifest after spawn", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await mgr.spawn({ label: "worker-a", command: "echo a" });
    await mgr.spawn({ label: "worker-b", command: "echo b" });

    const status = mgr.getStatus();
    expect(status!.workers).toHaveLength(2);
    expect(status!.workers[0].label).toBe("worker-a");
    expect(status!.workers[1].label).toBe("worker-b");
  });

  it("WorkerRecord has expected shape after spawn", async () => {
    const mgr = new OrchestratorManager(makeMockExec("%7"));
    const { runId, orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    const spawnTime = Date.now();
    await mgr.spawn({ label: "worker-x", command: "echo x", busChannel: "done" });

    const worker = mgr.getStatus()!.workers[0];
    expect(worker.label).toBe("worker-x");
    expect(worker.paneId).toBe(`orch-${runId}-worker-x`);
    expect(worker.tmuxPaneId).toBe("%7");
    expect(worker.busChannel).toBe("done");
    expect(worker.spawnedAt).toBeGreaterThanOrEqual(spawnTime);
    expect(worker.branch).toBeUndefined();
  });

  it("throws SPAWN_FAILED when tmux split-window fails", async () => {
    const failExec: ExecFn = async () => ({ stdout: "", stderr: "no session", code: 1 });
    const mgr = new OrchestratorManager(failExec);
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await expect(mgr.spawn({ label: "worker", command: "echo hi" })).rejects.toThrow(OrchError);
    try {
      await mgr.spawn({ label: "worker", command: "echo hi" });
    } catch (e) {
      expect((e as OrchError).code).toBe("SPAWN_FAILED");
    }
  });

  it("updates manifest on disk after each spawn", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await mgr.spawn({ label: "a", command: "echo a" });
    const { readManifest } = await import("../manifest");
    const m1 = readManifest(orchDir);
    expect(m1.workers).toHaveLength(1);

    await mgr.spawn({ label: "b", command: "echo b" });
    const m2 = readManifest(orchDir);
    expect(m2.workers).toHaveLength(2);
  });
});

describeIfEnabled("orch", "OrchestratorManager — cleanup()", () => {
  let saved: Record<string, string | undefined>;
  let extraBusDirs: string[] = [];

  beforeEach(() => {
    saved = captureEnv();
    extraBusDirs = [];
    process.env.TMUX = "test-session,0,0";
  });

  afterEach(() => {
    for (const dir of extraBusDirs) rmSync(dir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  it("throws NO_ACTIVE_RUN before start()", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    await expect(mgr.cleanup()).rejects.toThrow(OrchError);
    try {
      await mgr.cleanup();
    } catch (e) {
      expect((e as OrchError).code).toBe("NO_ACTIVE_RUN");
    }
  });

  it("removes orchDir on disk after cleanup", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${busSession}`);

    expect(existsSync(orchDir)).toBe(true);
    await mgr.cleanup();
    expect(existsSync(orchDir)).toBe(false);
  });

  it("removes bus session dir after cleanup", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { busSession } = mgr.start();

    expect(existsSync(`/tmp/pi-bus-${busSession}`)).toBe(true);
    await mgr.cleanup();
    expect(existsSync(`/tmp/pi-bus-${busSession}`)).toBe(false);
  });

  it("clears PI_BUS_SESSION and PI_AGENT_ID after cleanup", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    mgr.start();
    expect(process.env.PI_BUS_SESSION).toBeDefined();
    await mgr.cleanup();
    expect(process.env.PI_BUS_SESSION).toBeUndefined();
    expect(process.env.PI_AGENT_ID).toBeUndefined();
  });

  it("returns panes count matching spawned workers", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${busSession}`);

    await mgr.spawn({ label: "worker-1", command: "echo 1" });
    await mgr.spawn({ label: "worker-2", command: "echo 2" });

    const result = await mgr.cleanup();
    expect(result.panes).toBe(2);
    expect(result.worktrees).toBe(0);
    expect(result.preservedBranches).toHaveLength(0);
  });

  it("getStatus returns null after cleanup", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${busSession}`);
    await mgr.cleanup();
    expect(mgr.getStatus()).toBeNull();
  });

  it("writes run receipt to /tmp/orch-runs/", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${busSession}`);

    const result = await mgr.cleanup();
    expect(result.receiptPath).not.toBe("(not written)");
    expect(existsSync(result.receiptPath)).toBe(true);

    // Clean up receipt
    rmSync(result.receiptPath, { force: true });
  });

  it("allows start() again after cleanup", async () => {
    const mgr = new OrchestratorManager(makeMockExec());
    const r1 = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${r1.busSession}`);
    await mgr.cleanup();

    const r2 = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${r2.busSession}`);
    expect(r2.runId).not.toBe(r1.runId);
    await mgr.cleanup();
  });

  it("kill-pane failure does not block cleanup", async () => {
    const failKill: ExecFn = async (_cmd, args) => {
      if (args.includes("split-window")) return { stdout: "%1\n", stderr: "", code: 0 };
      if (args.includes("kill-pane")) return { stdout: "", stderr: "no such pane", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const mgr = new OrchestratorManager(failKill);
    const { orchDir, busSession } = mgr.start();
    extraBusDirs.push(`/tmp/pi-bus-${busSession}`);
    await mgr.spawn({ label: "worker", command: "echo hi" });

    // Should not throw despite kill-pane failing
    await expect(mgr.cleanup()).resolves.toBeDefined();
    expect(existsSync(orchDir)).toBe(false);
  });
});

// ─── buildPiCommand unit tests ───────────────────────────────

describe("buildPiCommand — command construction", () => {
  it("includes --no-session and --print always", () => {
    const cmd = buildPiCommand({ prompt: "do work" });
    expect(cmd).toContain("--no-session");
    expect(cmd).toContain("--print");
  });

  it("starts with 'pi'", () => {
    const cmd = buildPiCommand({ prompt: "hello" });
    expect(cmd.startsWith("pi ")).toBe(true);
  });

  it("includes --model when provided", () => {
    const cmd = buildPiCommand({ model: "claude-sonnet-4-6", prompt: "do work" });
    expect(cmd).toContain("--model claude-sonnet-4-6");
  });

  it("does not include --model when omitted", () => {
    const cmd = buildPiCommand({ prompt: "do work" });
    expect(cmd).not.toContain("--model");
  });

  it("includes --tools as comma-separated list", () => {
    const cmd = buildPiCommand({ tools: ["read", "bash"], prompt: "do work" });
    expect(cmd).toContain("--tools read,bash");
  });

  it("does not include --tools when array is empty", () => {
    const cmd = buildPiCommand({ tools: [], prompt: "do work" });
    expect(cmd).not.toContain("--tools");
  });

  it("does not include --tools when omitted", () => {
    const cmd = buildPiCommand({ prompt: "do work" });
    expect(cmd).not.toContain("--tools");
  });

  it("includes @brief path when provided", () => {
    const cmd = buildPiCommand({ brief: "/tmp/brief.md", prompt: "do work" });
    expect(cmd).toContain("@/tmp/brief.md");
  });

  it("does not include @brief when omitted", () => {
    const cmd = buildPiCommand({ prompt: "do work" });
    expect(cmd).not.toContain("@");
  });

  it("includes JSON-encoded prompt", () => {
    const cmd = buildPiCommand({ prompt: "do the work" });
    expect(cmd).toContain('"do the work"');
  });

  it("JSON-encodes prompts with special characters", () => {
    const cmd = buildPiCommand({ prompt: 'say "hello" world' });
    expect(cmd).toContain('\\"hello\\"');
  });

  it("builds full command with all options", () => {
    const cmd = buildPiCommand({
      model: "claude-haiku-4-5",
      tools: ["read", "bash"],
      brief: "/tmp/my-brief.md",
      prompt: "Do the task",
    });
    expect(cmd).toBe(
      'pi --no-session --print --model claude-haiku-4-5 --tools read,bash @/tmp/my-brief.md "Do the task"',
    );
  });

  it("builds command with only brief (no prompt)", () => {
    const cmd = buildPiCommand({ brief: "/tmp/brief.md" });
    expect(cmd).toContain("@/tmp/brief.md");
    expect(cmd).not.toContain("undefined");
  });

  it("throws on unknown tool names", () => {
    expect(() => buildPiCommand({ tools: ["read", "lsp"], prompt: "do work" })).toThrow(
      /Unknown built-in tool.*lsp/,
    );
  });

  it("throws listing all unknown tools", () => {
    expect(() => buildPiCommand({ tools: ["lsp", "bus", "bash"], prompt: "do work" })).toThrow(
      /Unknown built-in tool.*lsp, bus/,
    );
  });

  it("accepts all valid built-in tools", () => {
    const cmd = buildPiCommand({
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      prompt: "do work",
    });
    expect(cmd).toContain("--tools read,bash,edit,write,grep,find,ls");
  });
});

// ─── Pi spawner validation tests ─────────────────────────────

describeIfEnabled("orch", "OrchestratorManager — pi spawner validation", () => {
  let saved: Record<string, string | undefined>;
  let orchDirs: string[] = [];
  let busSessions: string[] = [];
  let tmpDirs: string[] = [];

  beforeEach(() => {
    saved = captureEnv();
    orchDirs = [];
    busSessions = [];
    tmpDirs = [];
    process.env.TMUX = "test-session,0,0";
  });

  afterEach(() => {
    for (const dir of orchDirs) rmSync(dir, { recursive: true, force: true });
    for (const sid of busSessions) rmSync(`/tmp/pi-bus-${sid}`, { recursive: true, force: true });
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  async function withRun(
    fn: (mgr: OrchestratorManager) => Promise<void>,
  ): Promise<void> {
    const mgr = new OrchestratorManager(makeMockExec());
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);
    await fn(mgr);
  }

  it("errors when command AND prompt both provided (AMBIGUOUS_SPAWN)", async () => {
    await withRun(async (mgr) => {
      await expect(
        mgr.spawn({ label: "worker", command: "echo hi", prompt: "do work" }),
      ).rejects.toThrow(OrchError);
      try {
        await mgr.spawn({ label: "worker", command: "echo hi", prompt: "do work" });
      } catch (e) {
        expect((e as OrchError).code).toBe("AMBIGUOUS_SPAWN");
      }
    });
  });

  it("errors when command AND brief both provided (AMBIGUOUS_SPAWN)", async () => {
    await withRun(async (mgr) => {
      const tmpDir = mkdtempSync("/tmp/orch-test-");
      tmpDirs.push(tmpDir);
      const briefPath = `${tmpDir}/brief.md`;
      writeFileSync(briefPath, "# Brief");

      await expect(
        mgr.spawn({ label: "worker", command: "echo hi", brief: briefPath }),
      ).rejects.toThrow(OrchError);
      try {
        await mgr.spawn({ label: "worker2", command: "echo hi", brief: briefPath });
      } catch (e) {
        expect((e as OrchError).code).toBe("AMBIGUOUS_SPAWN");
      }
    });
  });

  it("errors when command AND model both provided (AMBIGUOUS_SPAWN)", async () => {
    await withRun(async (mgr) => {
      await expect(
        mgr.spawn({ label: "worker", command: "echo hi", model: "claude-sonnet-4-6" }),
      ).rejects.toThrow(OrchError);
    });
  });

  it("errors when neither command nor prompt/brief provided (AMBIGUOUS_SPAWN)", async () => {
    await withRun(async (mgr) => {
      await expect(
        mgr.spawn({ label: "worker" }),
      ).rejects.toThrow(OrchError);
      try {
        await mgr.spawn({ label: "worker" });
      } catch (e) {
        expect((e as OrchError).code).toBe("AMBIGUOUS_SPAWN");
      }
    });
  });

  it("errors when only model provided (no command, prompt, or brief)", async () => {
    await withRun(async (mgr) => {
      await expect(
        mgr.spawn({ label: "worker", model: "claude-sonnet-4-6" }),
      ).rejects.toThrow(OrchError);
    });
  });

  it("errors when brief file does not exist (BRIEF_NOT_FOUND)", async () => {
    await withRun(async (mgr) => {
      await expect(
        mgr.spawn({ label: "worker", brief: "/tmp/nonexistent-brief-99999.md" }),
      ).rejects.toThrow(OrchError);
      try {
        await mgr.spawn({ label: "worker2", brief: "/tmp/nonexistent-brief-99999.md" });
      } catch (e) {
        expect((e as OrchError).code).toBe("BRIEF_NOT_FOUND");
      }
    });
  });

  it("spawns successfully with prompt only (no command)", async () => {
    await withRun(async (mgr) => {
      const result = await mgr.spawn({ label: "worker", prompt: "Do the work" });
      expect(result.paneId).toContain("worker");
    });
  });

  it("spawns successfully with brief and prompt", async () => {
    await withRun(async (mgr) => {
      const tmpDir = mkdtempSync("/tmp/orch-test-");
      tmpDirs.push(tmpDir);
      const briefPath = `${tmpDir}/brief.md`;
      writeFileSync(briefPath, "# Do the work");

      const result = await mgr.spawn({ label: "worker", brief: briefPath, prompt: "execute" });
      expect(result.paneId).toContain("worker");
    });
  });

  it("spawns with full pi-spawner params (model, tools, brief, prompt)", async () => {
    await withRun(async (mgr) => {
      const tmpDir = mkdtempSync("/tmp/orch-test-");
      tmpDirs.push(tmpDir);
      const briefPath = `${tmpDir}/brief.md`;
      writeFileSync(briefPath, "# Worker brief");

      const result = await mgr.spawn({
        label: "worker",
        model: "claude-haiku-4-5",
        tools: ["read", "bash"],
        brief: briefPath,
        prompt: "Do the task",
      });
      expect(result.paneId).toContain("worker");
    });
  });

  it("pi-spawner command contains expected pi flags in spawned command", async () => {
    // Capture the command passed to tmux split-window to verify pi command construction
    let capturedCommand = "";
    const captureExec: ExecFn = async (cmd, args) => {
      if (cmd === "tmux" && args.includes("split-window")) {
        // The command is the last arg in split-window
        capturedCommand = args[args.length - 1];
        return { stdout: "%42\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const mgr = new OrchestratorManager(captureExec);
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await mgr.spawn({
      label: "worker",
      model: "claude-sonnet-4-6",
      tools: ["read", "bash"],
      prompt: "Do the work",
    });

    // capturedCommand is the full env-wrapped shell command
    expect(capturedCommand).toContain("pi --no-session --print");
    expect(capturedCommand).toContain("--model claude-sonnet-4-6");
    expect(capturedCommand).toContain("--tools read,bash");
    expect(capturedCommand).toContain('"Do the work"');
  });

  it("pi-spawner command injects PI_BUS_SESSION into env", async () => {
    let capturedCommand = "";
    const captureExec: ExecFn = async (cmd, args) => {
      if (cmd === "tmux" && args.includes("split-window")) {
        capturedCommand = args[args.length - 1];
        return { stdout: "%42\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const mgr = new OrchestratorManager(captureExec);
    const { orchDir, busSession } = mgr.start();
    orchDirs.push(orchDir);
    busSessions.push(busSession);

    await mgr.spawn({ label: "worker", prompt: "Do the work" });

    expect(capturedCommand).toContain(`PI_BUS_SESSION=${busSession}`);
  });
});

// ─── prepareWorktree ─────────────────────────────────────────

import { prepareWorktree } from "../git";
import { readdirSync, lstatSync } from "node:fs";

describe("prepareWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/orch-test-wt-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("symlinks top-level node_modules from repo into worktree", () => {
    // Arrange: source repo has node_modules/, worktree does not
    const repoDir = mkdtempSync("/tmp/orch-test-repo-");
    const repoNM = `${repoDir}/node_modules`;
    mkdirSync(repoNM);

    try {
      prepareWorktree(repoDir, tmpDir);

      // Assert: symlink created at worktree/node_modules pointing to repo/node_modules
      const wtNM = `${tmpDir}/node_modules`;
      expect(existsSync(wtNM)).toBe(true);
      const stat = lstatSync(wtNM);
      expect(stat.isSymbolicLink()).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("symlinks per-extension node_modules for extensions that have them", () => {
    const repoDir = mkdtempSync("/tmp/orch-test-repo-");

    try {
      // Arrange: repo has .pi/extensions/dev-tools/node_modules/, worktree has the dir but no node_modules
      const repoDevToolsNM = `${repoDir}/.pi/extensions/dev-tools/node_modules`;
      mkdirSync(repoDevToolsNM, { recursive: true });

      const wtDevToolsDir = `${tmpDir}/.pi/extensions/dev-tools`;
      mkdirSync(wtDevToolsDir, { recursive: true });

      prepareWorktree(repoDir, tmpDir);

      const wtDevToolsNM = `${tmpDir}/.pi/extensions/dev-tools/node_modules`;
      expect(existsSync(wtDevToolsNM)).toBe(true);
      const stat = lstatSync(wtDevToolsNM);
      expect(stat.isSymbolicLink()).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("skips extension dirs where repo has no node_modules", () => {
    const repoDir = mkdtempSync("/tmp/orch-test-repo-");

    try {
      // Arrange: repo has extension dir but no node_modules inside it
      mkdirSync(`${repoDir}/.pi/extensions/bus`, { recursive: true });
      mkdirSync(`${tmpDir}/.pi/extensions/bus`, { recursive: true });

      prepareWorktree(repoDir, tmpDir);

      // No symlink created — bus extension has no local deps
      expect(existsSync(`${tmpDir}/.pi/extensions/bus/node_modules`)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("is idempotent — does not throw if symlink already exists", () => {
    const repoDir = mkdtempSync("/tmp/orch-test-repo-");

    try {
      mkdirSync(`${repoDir}/node_modules`);

      // Call twice — second call should be a no-op
      prepareWorktree(repoDir, tmpDir);
      expect(() => prepareWorktree(repoDir, tmpDir)).not.toThrow();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does nothing when repo has no node_modules", () => {
    const repoDir = mkdtempSync("/tmp/orch-test-repo-");

    try {
      // No node_modules in repo — prepareWorktree should silently skip
      prepareWorktree(repoDir, tmpDir);
      expect(existsSync(`${tmpDir}/node_modules`)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
