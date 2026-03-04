/**
 * Handoff extension — smoke tests.
 *
 * The extension registers a single `/handoff` command that composes a
 * prompt and hands it to sendUserMessage. There is no pure logic to unit
 * test, so this suite just confirms the module contract is intact.
 */

import { describe, expect, it, mock } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";

describeIfEnabled("handoff", "handoff extension", () => {
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
      };

      mod.default(mockPi as any);

      expect(registered.length).toBe(1);
      expect(registered[0].name).toBe("handoff");
      expect(typeof registered[0].opts.description).toBe("string");
      expect(registered[0].opts.description.length).toBeGreaterThan(0);
    });
  });
});
