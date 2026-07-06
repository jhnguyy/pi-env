import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { PiEvent } from "../../_shared/agent-tools";
import { registerDevToolsLifecycle } from "../lifecycle";

type Handler = (event?: any) => unknown;

function createPi() {
  const handlers = new Map<string, Handler[]>();
  return {
    sent: [] as Array<{ message: unknown; options: unknown }>,
    on(event: string, handler: Handler) {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    },
    async emit(event: string, payload?: unknown) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload));
      }
      return results;
    },
    async sendMessage(message: unknown, options?: unknown) {
      this.sent.push({ message, options });
    },
  };
}

describeIfEnabled("dev-tools", "dev-tools lifecycle", () => {
  it("removes stale post-edit feedback from context without sending new agent-end feedback", async () => {
    const pi = createPi();
    const state = registerDevToolsLifecycle(pi as any);

    await pi.emit(PiEvent.ToolResult, {
      toolName: "write",
      input: { path: "/repo/main.tf" },
    });
    await pi.emit(PiEvent.AgentEnd);

    expect(pi.sent).toEqual([]);

    const [context] = await pi.emit(PiEvent.Context, {
      messages: [
        { role: "user", content: "keep" },
        { role: "custom", customType: "dev-tools-agent-end", content: "stale" },
      ],
    });

    expect(context).toEqual({
      messages: [
        { role: "user", content: "keep" },
      ],
    });
    expect(state.removedStalePostEditMessages).toBe(1);
  });
});
