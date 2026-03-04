import { describe, expect, it, beforeEach } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { PaneManager } from "../pane-manager";
import { TmuxError } from "../types";
import type { ITmuxClient, TmuxConfig } from "../types";

// ─── Mock ITmuxClient ────────────────────────────────────────

function makeMockClient(overrides: Partial<ITmuxClient> = {}): ITmuxClient & {
  splitWindowCalls: Array<{ direction: string; command: string; targetPaneId?: string }>;
  sendKeysCalls: Array<{ paneId: string; text: string }>;
  setupPaneCalls: Array<{ paneId: string; title: string }>;
  capturePaneWithStatusCalls: string[];
  killPaneAndRebalanceCalls: string[];
  // granular methods kept for reconstruct / compat
  killPaneCalls: string[];
  setPaneTitleCalls: Array<{ paneId: string; title: string }>;
  capturePaneCalls: string[];
  rebalanceLayoutCalls: number;
  alivePanes: Set<string>;
} {
  const splitWindowCalls: Array<{ direction: string; command: string; targetPaneId?: string }> = [];
  const sendKeysCalls: Array<{ paneId: string; text: string }> = [];
  const setupPaneCalls: Array<{ paneId: string; title: string }> = [];
  const capturePaneWithStatusCalls: string[] = [];
  const killPaneAndRebalanceCalls: string[] = [];
  const killPaneCalls: string[] = [];
  const setPaneTitleCalls: Array<{ paneId: string; title: string }> = [];
  const capturePaneCalls: string[] = [];
  let rebalanceLayoutCalls = 0;
  const alivePanes = new Set<string>(["%5"]);
  let paneCounter = 5;

  return {
    splitWindowCalls,
    sendKeysCalls,
    setupPaneCalls,
    capturePaneWithStatusCalls,
    killPaneAndRebalanceCalls,
    killPaneCalls,
    setPaneTitleCalls,
    capturePaneCalls,
    get rebalanceLayoutCalls() { return rebalanceLayoutCalls; },
    alivePanes,

    isInTmux: overrides.isInTmux ?? (() => true),
    async splitWindow(direction, command, targetPaneId?) {
      splitWindowCalls.push({ direction, command, targetPaneId });
      const id = `%${++paneCounter}`;
      alivePanes.add(id);
      return id;
    },
    async setupPane(paneId, title) {
      setupPaneCalls.push({ paneId, title });
    },
    async sendKeys(paneId, text) {
      sendKeysCalls.push({ paneId, text });
    },
    async capturePaneWithStatus(paneId) {
      capturePaneWithStatusCalls.push(paneId);
      const alive = alivePanes.has(paneId);
      return { content: alive ? `output from ${paneId}` : "", alive };
    },
    async killPaneAndRebalance(paneId) {
      killPaneAndRebalanceCalls.push(paneId);
      alivePanes.delete(paneId);
    },
    // granular methods — used by reconstruct and tests that exercise them directly
    async killPane(paneId) {
      killPaneCalls.push(paneId);
      alivePanes.delete(paneId);
    },
    async setPaneTitle(paneId, title) {
      setPaneTitleCalls.push({ paneId, title });
    },
    async listPanes() {
      return Array.from(alivePanes);
    },
    async isPaneAlive(paneId) {
      return alivePanes.has(paneId);
    },
    async capturePaneContent(paneId) {
      capturePaneCalls.push(paneId);
      return `output from ${paneId}`;
    },
    async rebalanceLayout() {
      rebalanceLayoutCalls++;
    },
    ...overrides,
  };
}

const TEST_CONFIG: TmuxConfig = {
  sessionPrefix: "abcd",
};

describeIfEnabled("tmux", "PaneManager", () => {
  let client: ReturnType<typeof makeMockClient>;
  let manager: PaneManager;

  beforeEach(() => {
    client = makeMockClient();
    manager = new PaneManager(client, TEST_CONFIG);
  });

  // ─── run() ──────────────────────────────────────────────────

  describe("run()", () => {
    it("throws NOT_IN_TMUX when not in tmux session", async () => {
      const c = makeMockClient({ isInTmux: () => false });
      const m = new PaneManager(c, TEST_CONFIG);
      await expect(
        m.run({ action: "run", command: "echo hi", label: "test" }),
      ).rejects.toMatchObject({ name: "TmuxError", code: "NOT_IN_TMUX" });
    });

    it("always splits right regardless of how many panes exist", async () => {
      await manager.run({ action: "run", command: "echo a", label: "a" });
      await manager.run({ action: "run", command: "echo b", label: "b" });
      await manager.run({ action: "run", command: "echo c", label: "c" });
      for (const call of client.splitWindowCalls) {
        expect(call.direction).toBe("right");
      }
    });

    it("does not target a specific pane when splitting (rebalance handles layout)", async () => {
      await manager.run({ action: "run", command: "echo a", label: "a" });
      await manager.run({ action: "run", command: "echo b", label: "b" });
      for (const call of client.splitWindowCalls) {
        expect(call.targetPaneId).toBeUndefined();
      }
    });

    it("passes command directly when waitOnExit=false", async () => {
      await manager.run({
        action: "run",
        command: "uvicorn app:main",
        label: "service",
        waitOnExit: false,
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).toBe("uvicorn app:main");
    });

    it("does not wrap command with tee", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      expect(client.splitWindowCalls[0].command).not.toContain("tee");
    });

    it("wraps command with waitOnExit prompt when waitOnExit=true", async () => {
      await manager.run({
        action: "run",
        command: "pi -p",
        label: "gather",
        waitOnExit: true,
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).toContain("Press Enter to close");
      expect(cmd).toContain("read");
      expect(cmd).toContain("pi -p");
    });

    it("does not include tee in waitOnExit wrapper", async () => {
      await manager.run({
        action: "run",
        command: "pi -p",
        label: "gather",
        waitOnExit: true,
      });
      expect(client.splitWindowCalls[0].command).not.toContain("tee");
    });

    it("calls setupPane (title + rebalance) after spawning a pane", async () => {
      expect(client.setupPaneCalls.length).toBe(0);
      await manager.run({ action: "run", command: "echo hi", label: "test" });
      expect(client.setupPaneCalls.length).toBe(1);
    });

    it("calls setupPane for each spawned pane", async () => {
      await manager.run({ action: "run", command: "echo a", label: "a" });
      await manager.run({ action: "run", command: "echo b", label: "b" });
      expect(client.setupPaneCalls.length).toBe(2);
    });

    it("calls setupPane with the label", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "my-label",
      });
      expect(client.setupPaneCalls.length).toBe(1);
      expect(client.setupPaneCalls[0].title).toBe("my-label");
    });

    it("registers pane in registry", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      const panes = manager.getActivePanes();
      expect(panes.length).toBe(1);
      expect(panes[0].id).toBe(result.paneId);
      expect(panes[0].label).toBe("test");
    });

    it("returns paneId and tmuxPaneId (no outputFile)", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      expect(result.paneId).toMatch(/^abcd-[0-9a-f]{4}$/);
      expect(result.tmuxPaneId).toMatch(/^%\d+$/);
      expect((result as any).outputFile).toBeUndefined();
    });

    it("generates unique IDs across multiple runs", async () => {
      const results = await Promise.all([
        manager.run({ action: "run", command: "a", label: "a" }),
        manager.run({ action: "run", command: "b", label: "b" }),
        manager.run({ action: "run", command: "c", label: "c" }),
      ]);
      const ids = results.map((r) => r.paneId);
      expect(new Set(ids).size).toBe(3);
    });

    it("stored pane record has no watch, lastReadPos, or outputFile fields", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      const pane = manager.getPane(result.paneId)!;
      expect((pane as any).watch).toBeUndefined();
      expect((pane as any).lastReadPos).toBeUndefined();
      expect((pane as any).outputFile).toBeUndefined();
    });
  });

  // ─── run() with busChannel ───────────────────────────────────

  describe("run() with busChannel", () => {
    const SHIM_PATH = "/tmp/pi-bus-exit-shim";

    it("wraps command with shim call when busChannel is set", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        busChannel: "workers:a",
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).toStartWith("bash -c '");
      expect(cmd).toContain(SHIM_PATH);
      expect(cmd).toContain("workers:a");
      expect(cmd).toContain("echo hi");
    });

    it("uses the exact channel name in the shim call", async () => {
      await manager.run({
        action: "run",
        command: "pi -p",
        label: "scout",
        busChannel: "scouts:phase-1",
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).toContain(`${SHIM_PATH} scouts:phase-1`);
    });

    it("escapes single quotes in the original command", async () => {
      await manager.run({
        action: "run",
        command: "bash -c 'echo hi'",
        label: "worker",
        busChannel: "workers:a",
      });
      const cmd = client.splitWindowCalls[0].command;
      // Single quotes escaped as '\'' for safe bash -c '...' embedding
      expect(cmd).toContain("'\\''");
      expect(cmd).toContain("bash -c");
      expect(cmd).toContain("echo hi");
    });

    it("does not add wait prompt when only busChannel is set", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        busChannel: "workers:a",
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).not.toContain("Press Enter");
      expect(cmd).not.toContain("; read");
    });

    it("combines busChannel and waitOnExit in a single bash -c wrapper", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        busChannel: "workers:a",
        waitOnExit: true,
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).toStartWith("bash -c '");
      expect(cmd).toContain(SHIM_PATH);
      expect(cmd).toContain("Press Enter to close");
      expect(cmd).toContain("; read");
      // Single wrapper — only one bash -c at the start
      expect(cmd.indexOf("bash -c")).toBe(0);
    });

    it("shim call appears before wait prompt in combined wrapper", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        busChannel: "workers:a",
        waitOnExit: true,
      });
      const cmd = client.splitWindowCalls[0].command;
      const shimPos = cmd.indexOf(SHIM_PATH);
      const waitPos = cmd.indexOf("Press Enter to close");
      expect(shimPos).toBeGreaterThan(0);
      expect(waitPos).toBeGreaterThan(0);
      expect(shimPos).toBeLessThan(waitPos);
    });

    it("waitOnExit without busChannel does not include shim", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        waitOnExit: true,
      });
      const cmd = client.splitWindowCalls[0].command;
      expect(cmd).not.toContain(SHIM_PATH);
      expect(cmd).toContain("Press Enter to close");
    });

    it("pane record stores original command, not the wrapped command", async () => {
      const originalCmd = "echo hi";
      const result = await manager.run({
        action: "run",
        command: originalCmd,
        label: "worker",
        busChannel: "workers:a",
        waitOnExit: true,
      });
      const pane = manager.getPane(result.paneId)!;
      expect(pane.command).toBe(originalCmd);
    });

    it("writes shim file on first busChannel use", async () => {
      const { unlinkSync, existsSync: fsExists } = await import("node:fs");
      if (fsExists(SHIM_PATH)) unlinkSync(SHIM_PATH);

      await manager.run({
        action: "run",
        command: "echo hi",
        label: "worker",
        busChannel: "workers:a",
      });

      expect(fsExists(SHIM_PATH)).toBe(true);
    });

    it("does not rewrite shim file on subsequent busChannel uses", async () => {
      const { statSync } = await import("node:fs");

      // First call — ensures shim exists
      await manager.run({
        action: "run",
        command: "echo first",
        label: "worker-1",
        busChannel: "workers:a",
      });
      const mtimeBefore = statSync(SHIM_PATH).mtimeMs;

      // Brief pause so mtime would differ if the file were rewritten
      await new Promise<void>((r) => setTimeout(r, 20));

      await manager.run({
        action: "run",
        command: "echo second",
        label: "worker-2",
        busChannel: "workers:b",
      });
      const mtimeAfter = statSync(SHIM_PATH).mtimeMs;

      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });

  // ─── send() ─────────────────────────────────────────────────

  describe("send()", () => {
    it("throws PANE_NOT_FOUND for unknown paneId", async () => {
      await expect(manager.send("unknown-pane", "text")).rejects.toMatchObject({
        name: "TmuxError",
        code: "PANE_NOT_FOUND",
      });
    });

    it("sends keys to interactive pane and returns ok", async () => {
      const result = await manager.run({
        action: "run",
        command: "bash",
        label: "shell",
        interactive: true,
      });
      const sendResult = await manager.send(result.paneId, "ls -la");
      expect(sendResult).toEqual({ ok: true });
      expect(client.sendKeysCalls.length).toBe(1);
      expect(client.sendKeysCalls[0].text).toBe("ls -la");
    });

    it("returns warning for non-interactive pane but still sends", async () => {
      const result = await manager.run({
        action: "run",
        command: "pi -p",
        label: "gather",
        interactive: false,
      });
      const sendResult = await manager.send(result.paneId, "text");
      expect(sendResult.ok).toBe(true);
      expect(sendResult.warning).toBeTruthy();
      expect(client.sendKeysCalls.length).toBe(1);
    });
  });

  // ─── read() ─────────────────────────────────────────────────

  describe("read()", () => {
    it("throws PANE_NOT_FOUND for unknown paneId", async () => {
      await expect(manager.read("unknown-pane")).rejects.toMatchObject({
        name: "TmuxError",
        code: "PANE_NOT_FOUND",
      });
    });

    it("calls capturePaneWithStatus with the pane's tmuxPaneId", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      await manager.read(result.paneId);
      expect(client.capturePaneWithStatusCalls).toContain(result.tmuxPaneId);
    });

    it("returns captured content and alive status from the client", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      const readResult = await manager.read(result.paneId);
      expect(readResult.content).toBe(`output from ${result.tmuxPaneId}`);
      expect(readResult.alive).toBe(true);
    });
  });

  // ─── close() ────────────────────────────────────────────────

  describe("close()", () => {
    it("throws PANE_NOT_FOUND for unknown paneId", async () => {
      await expect(manager.close("unknown-pane")).rejects.toMatchObject({
        name: "TmuxError",
        code: "PANE_NOT_FOUND",
      });
    });

    it("deregisters pane without killing when kill=false (default)", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      await manager.close(result.paneId);
      expect(manager.getActivePanes().length).toBe(0);
      expect(client.killPaneAndRebalanceCalls.length).toBe(0);
    });

    it("calls killPaneAndRebalance and deregisters when kill=true", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      const tmuxPaneId = result.tmuxPaneId;
      await manager.close(result.paneId, true);
      expect(manager.getActivePanes().length).toBe(0);
      expect(client.killPaneAndRebalanceCalls).toContain(tmuxPaneId);
    });

    it("does not call killPaneAndRebalance when kill=false", async () => {
      const result = await manager.run({
        action: "run",
        command: "echo hi",
        label: "test",
      });
      await manager.close(result.paneId, false);
      expect(client.killPaneAndRebalanceCalls.length).toBe(0);
    });
  });

  // ─── getActivePanes() ───────────────────────────────────────

  describe("getActivePanes()", () => {
    it("returns all registered panes", async () => {
      await manager.run({ action: "run", command: "a", label: "a" });
      await manager.run({ action: "run", command: "b", label: "b" });
      const panes = manager.getActivePanes();
      expect(panes.length).toBe(2);
    });

    it("returns empty array when no panes registered", () => {
      expect(manager.getActivePanes()).toEqual([]);
    });
  });

  // ─── getSummary() ───────────────────────────────────────────

  describe("getSummary()", () => {
    it("returns empty string when no panes", () => {
      expect(manager.getSummary()).toBe("");
    });

    it("formats pane list correctly", async () => {
      await manager.run({
        action: "run",
        command: "echo hi",
        label: "gather",
        interactive: false,
      });
      const summary = manager.getSummary();
      expect(summary).toContain("Active panes:");
      expect(summary).toContain("gather");
      expect(summary).toContain("non-interactive");
    });

    it("shows interactive flag correctly", async () => {
      await manager.run({
        action: "run",
        command: "bash",
        label: "shell",
        interactive: true,
      });
      const summary = manager.getSummary();
      expect(summary).toContain("interactive");
    });
  });

  // ─── reconstruct() ──────────────────────────────────────────

  describe("reconstruct()", () => {
    it("re-registers alive panes from session entries", async () => {
      client.alivePanes.add("%99");
      await manager.reconstruct([
        {
          type: "message",
          id: "e1",
          parentId: null,
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "tmux",
            content: [{ type: "text", text: "spawned" }],
            details: {
              action: "run",
              paneId: "abcd-1234",
              tmuxPaneId: "%99",
              label: "gather",
              command: "echo hi",
              interactive: false,
              waitOnExit: false,
              createdAt: 1234567890,
            },
            isError: false,
            timestamp: Date.now(),
          },
        } as any,
      ]);
      const panes = manager.getActivePanes();
      expect(panes.length).toBe(1);
      expect(panes[0].id).toBe("abcd-1234");
      expect(panes[0].tmuxPaneId).toBe("%99");
    });

    it("reconstructed pane record has correct fields and no legacy fields", async () => {
      client.alivePanes.add("%99");
      await manager.reconstruct([
        {
          type: "message",
          id: "e1",
          parentId: null,
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "tmux",
            content: [{ type: "text", text: "spawned" }],
            details: {
              action: "run",
              paneId: "abcd-1234",
              tmuxPaneId: "%99",
              label: "gather",
              command: "echo hi",
              interactive: false,
              waitOnExit: false,
              createdAt: 1234567890,
            },
            isError: false,
            timestamp: Date.now(),
          },
        } as any,
      ]);
      const pane = manager.getActivePanes()[0];
      expect(pane.id).toBe("abcd-1234");
      expect(pane.tmuxPaneId).toBe("%99");
      expect(pane.label).toBe("gather");
      expect(pane.command).toBe("echo hi");
      expect(pane.interactive).toBe(false);
      expect(pane.waitOnExit).toBe(false);
      expect(pane.createdAt).toBe(1234567890);
      expect((pane as any).watch).toBeUndefined();
      expect((pane as any).lastReadPos).toBeUndefined();
      expect((pane as any).outputFile).toBeUndefined();
    });

    it("reconstruct round-trip: run → capture details → reconstruct → fields match", async () => {
      // Simulate what index.ts stores in details on run
      const runResult = await manager.run({
        action: "run",
        command: "echo hello",
        label: "round-trip",
        interactive: true,
        waitOnExit: false,
      });
      const storedPane = manager.getPane(runResult.paneId)!;

      // Simulate a session entry as index.ts would store it
      const fakeDetails = {
        action: "run",
        paneId: runResult.paneId,
        tmuxPaneId: runResult.tmuxPaneId,
        label: storedPane.label,
        command: storedPane.command,
        interactive: storedPane.interactive,
        waitOnExit: storedPane.waitOnExit,
        createdAt: storedPane.createdAt,
      };

      // Reset and reconstruct
      manager.cleanup();
      await manager.reconstruct([
        {
          type: "message",
          id: "e-rt",
          parentId: null,
          message: {
            role: "toolResult",
            toolCallId: "tc-rt",
            toolName: "tmux",
            content: [{ type: "text", text: "spawned" }],
            details: fakeDetails,
            isError: false,
            timestamp: Date.now(),
          },
        } as any,
      ]);

      const reconstructed = manager.getPane(runResult.paneId)!;
      expect(reconstructed.id).toBe(storedPane.id);
      expect(reconstructed.tmuxPaneId).toBe(storedPane.tmuxPaneId);
      expect(reconstructed.label).toBe(storedPane.label);
      expect(reconstructed.command).toBe(storedPane.command);
      expect(reconstructed.interactive).toBe(storedPane.interactive);
      expect(reconstructed.waitOnExit).toBe(storedPane.waitOnExit);
      expect(reconstructed.createdAt).toBe(storedPane.createdAt);
    });

    it("skips dead panes (not alive in tmux) and attempts reap via killPane", async () => {
      // %dead is NOT in alivePanes
      await manager.reconstruct([
        {
          type: "message",
          id: "e2",
          parentId: null,
          message: {
            role: "toolResult",
            toolCallId: "tc2",
            toolName: "tmux",
            content: [{ type: "text", text: "spawned" }],
            details: {
              action: "run",
              paneId: "abcd-dead",
              tmuxPaneId: "%dead",
              label: "old",
              command: "echo bye",
              interactive: false,
              waitOnExit: false,
              createdAt: 1234567890,
            },
            isError: false,
            timestamp: Date.now(),
          },
        } as any,
      ]);
      expect(manager.getActivePanes().length).toBe(0);
      // Best-effort reap should have been attempted on the dead pane
      expect(client.killPaneCalls).toContain("%dead");
    });

    it("ignores non-tmux tool results", async () => {
      await manager.reconstruct([
        {
          type: "message",
          id: "e3",
          parentId: null,
          message: {
            role: "toolResult",
            toolCallId: "tc3",
            toolName: "bash",
            content: [{ type: "text", text: "done" }],
            details: {},
            isError: false,
            timestamp: Date.now(),
          },
        } as any,
      ]);
      expect(manager.getActivePanes().length).toBe(0);
    });
  });

  // ─── cleanup() ──────────────────────────────────────────────

  describe("cleanup()", () => {
    it("clears registry without killing panes", async () => {
      await manager.run({ action: "run", command: "a", label: "a" });
      await manager.run({ action: "run", command: "b", label: "b" });
      manager.cleanup();
      expect(manager.getActivePanes().length).toBe(0);
      expect(client.killPaneCalls.length).toBe(0);
    });
  });
});
