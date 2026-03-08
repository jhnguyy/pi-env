/**
 * Work-tracker commands — smoke tests.
 *
 * Verifies that all registered commands (/handoff, /review-retros, /todo)
 * work correctly through a mock pi API.
 */

import { describe, expect, it } from "bun:test";

describe("work-tracker commands", () => {
  // ─── Helper: load module and capture registrations ────────────────

  async function loadWithMock() {
    const mod = await import("../index");

    const registered: Array<{
      name: string;
      opts: { description: string; handler: (...a: any[]) => any };
    }> = [];
    const hooks: Record<string, Function[]> = {};
    const messages: string[] = [];
    const tools: Array<{ name: string }> = [];

    const mockPi = {
      registerCommand(name: string, opts: any) {
        registered.push({ name, opts });
      },
      on(event: string, handler: Function) {
        if (!hooks[event]) hooks[event] = [];
        hooks[event].push(handler);
      },
      sendUserMessage(msg: string) {
        messages.push(msg);
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      getActiveTools() { return []; },
      setActiveTools() {},
    };

    mod.default(mockPi as any);
    return { registered, hooks, messages, tools };
  }

  function getCommand(registered: any[], name: string) {
    return registered.find((r: any) => r.name === name);
  }

  // ─── /review-retros ───────────────────────────────────────────────

  describe("/review-retros", () => {
    it("registers a 'review-retros' command", async () => {
      const { registered } = await loadWithMock();
      const cmd = getCommand(registered, "review-retros");
      expect(cmd).toBeDefined();
      expect(typeof cmd!.opts.description).toBe("string");
      expect(cmd!.opts.description.length).toBeGreaterThan(0);
    });

    it("handler sends a user message mentioning default count (5)", async () => {
      const { registered, messages } = await loadWithMock();
      const cmd = getCommand(registered, "review-retros")!;
      cmd.opts.handler(undefined, {});
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes("5"))).toBe(true);
      expect(messages.some((m) => m.includes("retro"))).toBe(true);
    });

    it("handler sends a user message mentioning custom count (3)", async () => {
      const { registered, messages } = await loadWithMock();
      const cmd = getCommand(registered, "review-retros")!;
      cmd.opts.handler("3", {});
      expect(messages.some((m) => m.includes("3"))).toBe(true);
    });
  });

  // ─── /handoff ─────────────────────────────────────────────────────

  describe("/handoff", () => {
    it("registers a 'handoff' command", async () => {
      const { registered } = await loadWithMock();
      const cmd = getCommand(registered, "handoff");
      expect(cmd).toBeDefined();
      expect(typeof cmd!.opts.description).toBe("string");
    });

    it("handler queues two sendUserMessage calls (handoff + retro)", async () => {
      const { registered, messages } = await loadWithMock();
      const cmd = getCommand(registered, "handoff")!;

      await cmd.opts.handler(undefined, {
        waitForIdle: async () => {},
        model: { provider: "test", id: "model" },
      });

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0));

      expect(messages.length).toBe(2);
      expect(messages[0]).toContain("handoff");
      expect(messages[1]).toContain("retrospective");
      expect(messages[1]).toContain("~/.pi/retro/");
      expect(messages[1]).toContain("### Patterns");
    });
  });

  // ─── /todo ────────────────────────────────────────────────────────

  describe("/todo", () => {
    it("registers a 'todo' command", async () => {
      const { registered } = await loadWithMock();
      const cmd = getCommand(registered, "todo");
      expect(cmd).toBeDefined();
      expect(cmd!.opts.description).toContain("/todo");
    });

    it("add and complete a task via handler", async () => {
      const { registered } = await loadWithMock();
      const cmd = getCommand(registered, "todo")!;
      const notifications: Array<{ msg: string; level: string }> = [];
      const widgets: Array<{ id: string; lines: string[] }> = [];
      const mockCtx = {
        ui: {
          notify(msg: string, level: string) { notifications.push({ msg, level }); },
          setWidget(id: string, lines: string[]) { widgets.push({ id, lines }); },
        },
      };

      // Add a task
      await cmd.opts.handler("test task", mockCtx);
      expect(notifications.length).toBe(1);
      expect(notifications[0].msg).toContain("test task");

      // Complete it
      notifications.length = 0;
      await cmd.opts.handler("done 1", mockCtx);
      expect(notifications.length).toBe(1);
      expect(notifications[0].msg).toContain("✅");
    });
  });

  // ─── read_session tool ────────────────────────────────────────────

  describe("read_session tool", () => {
    it("registers a read_session tool", async () => {
      const { tools } = await loadWithMock();
      expect(tools.some((t) => t.name === "read_session")).toBe(true);
    });
  });

  // ─── All commands registered ──────────────────────────────────────

  it("registers exactly 3 commands", async () => {
    const { registered } = await loadWithMock();
    expect(registered.length).toBe(3);
    const names = registered.map((r) => r.name).sort();
    expect(names).toEqual(["handoff", "review-retros", "todo"]);
  });
});
