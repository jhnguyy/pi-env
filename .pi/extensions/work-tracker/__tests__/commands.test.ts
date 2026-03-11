/**
 * Work-tracker commands — smoke tests.
 *
 * Verifies that both /review-retros and /handoff register correctly and that
 * their handlers call sendUserMessage with the expected content.
 *
 * These are smoke tests only — there is no pure logic to unit test.
 * The suite confirms the module contract is intact after the commands.ts split.
 */

import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";

// ─── Shared mock builder ──────────────────────────────────────────────────────

function makeCommandCaptureMock(targetCommand?: string, captureMessages?: string[]) {
  const registered: Array<{ name: string; opts: { description: string; handler: (...a: any[]) => any } }> = [];
  const messages: string[] = captureMessages ?? [];

  const mockPi = {
    registerCommand(name: string, opts: { description: string; handler: (...a: any[]) => any }) {
      registered.push({ name, opts });
      // If a target command is specified, invoke its handler immediately
      if (targetCommand && name === targetCommand) {
        opts.handler(undefined, { waitForIdle: async () => {}, model: { provider: "test", id: "model" } });
      }
    },
    registerTool: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {},
    on: () => {},
    sendUserMessage(msg: string) { messages.push(msg); },
  };

  return { mockPi, registered, messages };
}

// ─── Module contract ──────────────────────────────────────────────────────────

describeIfEnabled("work-tracker", "module contract", () => {
  it("exports a default function", async () => {
    const mod = await import("../index");
    expect(typeof mod.default).toBe("function");
  });

  it("default export accepts one argument (pi: ExtensionAPI)", async () => {
    const mod = await import("../index");
    expect(mod.default.length).toBe(1);
  });
});

// ─── /review-retros ───────────────────────────────────────────────────────────

describeIfEnabled("work-tracker", "/review-retros command", () => {
  it("registers a 'review-retros' command with a description", async () => {
    const mod = await import("../index");
    const { mockPi, registered } = makeCommandCaptureMock();
    mod.default(mockPi as any);

    const cmd = registered.find((r) => r.name === "review-retros");
    expect(cmd).toBeDefined();
    expect(typeof cmd!.opts.description).toBe("string");
    expect(cmd!.opts.description.length).toBeGreaterThan(0);
  });

  it("handler sends a user message mentioning default count (5)", async () => {
    const mod = await import("../index");
    const messages: string[] = [];
    const { mockPi } = makeCommandCaptureMock("review-retros", messages);
    mod.default(mockPi as any);

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("5");
    expect(messages[0]).toContain("retro");
  });

  it("handler sends a user message mentioning custom count when arg is passed", async () => {
    const mod = await import("../index");
    const registered: Array<{ name: string; opts: { description: string; handler: (...a: any[]) => any } }> = [];
    const messages: string[] = [];
    const mockPi = {
      registerCommand(name: string, opts: { description: string; handler: (...a: any[]) => any }) {
        registered.push({ name, opts });
        if (name === "review-retros") opts.handler("3", {});
      },
      registerTool: () => {}, getActiveTools: () => [] as string[],
      setActiveTools: () => {}, on: () => {},
      sendUserMessage(msg: string) { messages.push(msg); },
    };
    mod.default(mockPi as any);

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("3");
  });
});

// ─── /handoff ─────────────────────────────────────────────────────────────────

describeIfEnabled("work-tracker", "/handoff command", () => {
  it("registers a 'handoff' command with a description", async () => {
    const mod = await import("../index");
    const { mockPi, registered } = makeCommandCaptureMock();
    mod.default(mockPi as any);

    const cmd = registered.find((r) => r.name === "handoff");
    expect(cmd).toBeDefined();
    expect(typeof cmd!.opts.description).toBe("string");
    expect(cmd!.opts.description.length).toBeGreaterThan(0);
  });

  it("handler queues two sendUserMessage calls (handoff + retro)", async () => {
    const mod = await import("../index");

    const messages: string[] = [];
    let handoffHandler: ((args: any, ctx: any) => Promise<void>) | undefined;
    const mockPi = {
      registerCommand(name: string, opts: { description: string; handler: (args: any, ctx: any) => Promise<void> }) {
        if (name === "handoff") handoffHandler = opts.handler;
      },
      registerTool: () => {}, getActiveTools: () => [] as string[],
      setActiveTools: () => {}, on: () => {},
      sendUserMessage(msg: string) { messages.push(msg); },
    };

    mod.default(mockPi as any);

    await handoffHandler!(undefined, {
      waitForIdle: async () => {},
      model: { provider: "test", id: "model" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(messages.length).toBe(2);
    expect(messages[0]).toContain("handoff");
    expect(messages[1]).toContain("retrospective");
    expect(messages[1]).toContain("~/.pi/retro/");
    expect(messages[1]).toContain("### Patterns");
  });
});
