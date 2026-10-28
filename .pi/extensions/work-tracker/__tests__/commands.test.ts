import { describe, expect, it } from "vitest";

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

// ─── /review-retros ───────────────────────────────────────────────────────────

describe("/review-retros command", () => {
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
