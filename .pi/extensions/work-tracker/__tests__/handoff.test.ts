/**
 * Handoff command — smoke tests (moved from handoff extension).
 *
 * The /handoff command composes a prompt and hands it to sendUserMessage.
 * There is no pure logic to unit test, so this suite confirms the module
 * contract is intact after absorption into work-tracker.
 */

import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";

describeIfEnabled("work-tracker", "handoff command", () => {
  describe("module contract", () => {
    it("exports a default function", async () => {
      const mod = await import("../index");
      expect(typeof mod.default).toBe("function");
    });

    it("default export accepts one argument (pi: ExtensionAPI)", async () => {
      const mod = await import("../index");
      expect(mod.default.length).toBe(1);
    });

    it("registers a 'handoff' command", async () => {
      const mod = await import("../index");

      const registered: Array<{ name: string; opts: { description: string } }> = [];
      const mockPi = {
        registerCommand(name: string, opts: { description: string; handler: unknown }) {
          registered.push({ name, opts });
        },
        registerTool: () => {},
        getActiveTools: () => [] as string[],
        setActiveTools: () => {},
        on: () => {},
        sendUserMessage: () => {},
      };

      mod.default(mockPi as any);

      const handoffCmd = registered.find((r) => r.name === "handoff");
      expect(handoffCmd).toBeDefined();
      expect(typeof handoffCmd!.opts.description).toBe("string");
      expect(handoffCmd!.opts.description.length).toBeGreaterThan(0);
    });

    it("handler queues two sendUserMessage calls (handoff + retro)", async () => {
      const mod = await import("../index");

      const messages: string[] = [];
      let handoffHandler: ((args: any, ctx: any) => Promise<void>) | undefined;
      const mockPi = {
        registerCommand(
          name: string,
          opts: { description: string; handler: (args: any, ctx: any) => Promise<void> },
        ) {
          if (name === "handoff") handoffHandler = opts.handler;
        },
        registerTool: () => {},
        getActiveTools: () => [] as string[],
        setActiveTools: () => {},
        on: () => {},
        sendUserMessage(msg: string) {
          messages.push(msg);
        },
      };

      mod.default(mockPi as any);

      // Invoke the handoff handler with a mock ctx
      await handoffHandler!(undefined, {
        waitForIdle: async () => {},
        model: { provider: "test", id: "model" },
      });

      // Allow microtasks to flush (handler is async)
      await new Promise((r) => setTimeout(r, 0));

      expect(messages.length).toBe(2);
      expect(messages[0]).toContain("handoff");
      expect(messages[1]).toContain("retrospective");
      expect(messages[1]).toContain("~/.pi/retro/");
      expect(messages[1]).toContain("### Patterns");
    });
  });
});
