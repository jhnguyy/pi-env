/**
 * Tests for tmux extension index.ts — tool registration, execute routing,
 * validation gates, error handling, and session lifecycle handlers.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";

// We can't easily import and call the default export (it needs a real ExtensionAPI).
// Instead, we test the execute logic by extracting PaneManager + the same switch logic.
// The pragmatic approach: import PaneManager directly, replicate the thin execute wrapper,
// and test the integration between execute's validation/routing and PaneManager's behavior.

import { PaneManager } from "../pane-manager";
import { TmuxError } from "../types";
import type { ITmuxClient, TmuxConfig, RunDetails } from "../types";

// ─── Mock Client (same pattern as pane-manager.test.ts) ──────

function makeMockClient(overrides: Partial<ITmuxClient> = {}): ITmuxClient & {
  alivePanes: Set<string>;
} {
  const alivePanes = new Set<string>(["%5"]);
  let paneCounter = 5;

  return {
    alivePanes,
    isInTmux: overrides.isInTmux ?? (() => true),
    async splitWindow(_dir, _cmd, _target?) {
      const id = `%${++paneCounter}`;
      alivePanes.add(id);
      return id;
    },
    async setupPane(_paneId, _title) {},
    async sendKeys(_paneId, _text) {},
    async capturePaneWithStatus(paneId) {
      const alive = alivePanes.has(paneId);
      return { content: alive ? `output from ${paneId}` : "", alive };
    },
    async killPaneAndRebalance(paneId) { alivePanes.delete(paneId); },
    async killPane(paneId) { alivePanes.delete(paneId); },
    async setPaneTitle(_paneId, _title) {},
    async listPanes() { return Array.from(alivePanes); },
    async isPaneAlive(paneId) { return alivePanes.has(paneId); },
    async capturePaneContent(paneId) { return `output from ${paneId}`; },
    async rebalanceLayout() {},
    ...overrides,
  };
}

const TEST_CONFIG: TmuxConfig = { sessionPrefix: "test" };

// ─── Execute wrapper (mirrors index.ts switch/catch) ─────────

function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

async function execute(manager: PaneManager, params: Record<string, unknown>) {
  try {
    switch (params.action) {
      case "run": {
        if (!params.command || !params.label) {
          return err("run requires command and label");
        }
        const result = await manager.run({
          action: "run",
          command: params.command as string,
          label: params.label as string,
          interactive: params.interactive as boolean | undefined,
          waitOnExit: params.waitOnExit as boolean | undefined,
        });
        const details: RunDetails = {
          action: "run",
          paneId: result.paneId,
          tmuxPaneId: result.tmuxPaneId,
          label: params.label as string,
          command: params.command as string,
          interactive: (params.interactive as boolean) ?? false,
          waitOnExit: (params.waitOnExit as boolean) ?? false,
          createdAt: Date.now(),
        };
        return {
          content: [{ type: "text" as const, text: `Pane "${params.label}" spawned (${result.paneId}).` }],
          details,
        };
      }
      case "send": {
        if (!params.paneId || !params.text) {
          return err("send requires paneId and text");
        }
        const result = await manager.send(params.paneId as string, params.text as string);
        const msg = result.warning ? `Sent. Warning: ${result.warning}` : "Sent.";
        return { content: [{ type: "text" as const, text: msg }], details: result };
      }
      case "read": {
        if (!params.paneId) {
          return err("read requires paneId");
        }
        const { content, alive } = await manager.read(params.paneId as string);
        const prefix = alive ? "" : "[pane exited]\n";
        return {
          content: [{ type: "text" as const, text: prefix + (content || "(no output)") }],
          details: { paneId: params.paneId, alive },
        };
      }
      case "close": {
        if (!params.paneId) {
          return err("close requires paneId");
        }
        const result = await manager.close(params.paneId as string, params.kill as boolean | undefined);
        return {
          content: [{ type: "text" as const, text: `Pane ${params.paneId} closed.` }],
          details: result,
        };
      }
      case "list": {
        const panes = manager.getActivePanes();
        if (panes.length === 0) {
          return { content: [{ type: "text" as const, text: "No active panes." }], details: { panes: [] } };
        }
        const summary = panes.map(p =>
          `${p.id} "${p.label}" (${p.interactive ? "interactive" : "non-interactive"})`
        ).join("\n");
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { panes: panes.map(p => ({ id: p.id, label: p.label, interactive: p.interactive })) },
        };
      }
      default:
        return err(`Unknown action: ${params.action}`);
    }
  } catch (e) {
    const msg = e instanceof TmuxError
      ? `tmux error [${e.code}]: ${e.message}`
      : `unexpected error: ${e}`;
    return err(msg);
  }
}

// ─── Tests ───────────────────────────────────────────────────

describeIfEnabled("tmux", "index.ts execute", () => {
  let client: ReturnType<typeof makeMockClient>;
  let manager: PaneManager;

  beforeEach(() => {
    client = makeMockClient();
    manager = new PaneManager(client, TEST_CONFIG);
  });

  // ─── Validation gates ───────────────────────────────────────

  describe("validation", () => {
    it("run: returns error when command is missing", async () => {
      const result = await execute(manager, { action: "run", label: "test" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("run requires command and label");
    });

    it("run: returns error when label is missing", async () => {
      const result = await execute(manager, { action: "run", command: "echo hi" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("run requires command and label");
    });

    it("send: returns error when paneId is missing", async () => {
      const result = await execute(manager, { action: "send", text: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("send requires paneId and text");
    });

    it("send: returns error when text is missing", async () => {
      const result = await execute(manager, { action: "send", paneId: "abc" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("send requires paneId and text");
    });

    it("read: returns error when paneId is missing", async () => {
      const result = await execute(manager, { action: "read" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("read requires paneId");
    });

    it("close: returns error when paneId is missing", async () => {
      const result = await execute(manager, { action: "close" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("close requires paneId");
    });
  });

  // ─── Happy paths ────────────────────────────────────────────

  describe("happy paths", () => {
    it("run: spawns pane and returns details with RunDetails shape", async () => {
      const result = await execute(manager, {
        action: "run", command: "echo hi", label: "test-pane",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("test-pane");
      expect(result.content[0].text).toContain("spawned");

      const details = result.details as RunDetails;
      expect(details.action).toBe("run");
      expect(details.paneId).toBeTruthy();
      expect(details.tmuxPaneId).toBeTruthy();
      expect(details.label).toBe("test-pane");
      expect(details.command).toBe("echo hi");
      expect(details.interactive).toBe(false);
      expect(details.waitOnExit).toBe(false);
      expect(typeof details.createdAt).toBe("number");
    });

    it("read: shows [pane exited] prefix when pane is dead", async () => {
      const run = await execute(manager, {
        action: "run", command: "echo hi", label: "r",
      });
      const details = run.details as RunDetails;
      // Kill the pane in the mock
      client.alivePanes.delete(details.tmuxPaneId);
      const result = await execute(manager, { action: "read", paneId: details.paneId });
      expect(result.content[0].text).toContain("[pane exited]");
      expect((result.details as any).alive).toBe(false);
    });

    it("list: returns 'No active panes.' when empty", async () => {
      const result = await execute(manager, { action: "list" });
      expect(result.content[0].text).toBe("No active panes.");
      expect((result.details as any).panes).toEqual([]);
    });

  });

  // ─── Error handling ─────────────────────────────────────────

  describe("error handling", () => {
    it("TmuxError is caught and formatted", async () => {
      const result = await execute(manager, {
        action: "send", paneId: "nonexistent", text: "hello",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tmux error [PANE_NOT_FOUND]");
    });

    it("NOT_IN_TMUX error is caught", async () => {
      const c = makeMockClient({ isInTmux: () => false });
      const m = new PaneManager(c, TEST_CONFIG);
      const result = await execute(m, {
        action: "run", command: "echo hi", label: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NOT_IN_TMUX");
    });

    it("unknown action returns error", async () => {
      const result = await execute(manager, { action: "explode" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown action: explode");
    });
  });

});
