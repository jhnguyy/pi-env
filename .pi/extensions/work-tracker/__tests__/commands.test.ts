/**
 * Work-tracker commands — smoke tests.
 *
 * Verifies that /review-retros registers correctly and that its handler
 * calls sendUserMessage with a prompt mentioning the expected retro count.
 */

import { describe, expect, it, mock } from "bun:test";

describe("work-tracker commands", () => {
  describe("/review-retros registration", () => {
    it("registers a 'review-retros' command", async () => {
      const mod = await import("../index");

      const registered: Array<{ name: string; opts: { description: string } }> = [];
      const mockPi = {
        registerCommand(name: string, opts: { description: string; handler: unknown }) {
          registered.push({ name, opts });
        },
        on: () => {},
        sendUserMessage: () => {},
      };

      mod.default(mockPi as any);

      const cmd = registered.find((r) => r.name === "review-retros");
      expect(cmd).toBeDefined();
      expect(typeof cmd!.opts.description).toBe("string");
      expect(cmd!.opts.description.length).toBeGreaterThan(0);
    });

    it("handler sends a user message mentioning default count (5)", async () => {
      const mod = await import("../index");

      const messages: string[] = [];
      const mockPi = {
        registerCommand(name: string, opts: { description: string; handler: (...a: any[]) => any }) {
          if (name === "review-retros") {
            // Invoke the handler immediately with no args (default N=5)
            opts.handler(undefined, {});
          }
        },
        on: () => {},
        sendUserMessage(msg: string) {
          messages.push(msg);
        },
      };

      mod.default(mockPi as any);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toContain("5");
      expect(messages[0]).toContain("retro");
    });

    it("handler sends a user message mentioning custom count (3)", async () => {
      const mod = await import("../index");

      const messages: string[] = [];
      const mockPi = {
        registerCommand(name: string, opts: { description: string; handler: (...a: any[]) => any }) {
          if (name === "review-retros") {
            opts.handler("3", {});
          }
        },
        on: () => {},
        sendUserMessage(msg: string) {
          messages.push(msg);
        },
      };

      mod.default(mockPi as any);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toContain("3");
    });
  });
});
