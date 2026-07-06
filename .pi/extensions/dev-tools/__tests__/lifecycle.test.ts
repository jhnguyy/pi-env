import { describe, expect, it, vi } from "vitest";
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
  it("records edited files, sends deferred formatter feedback, and keeps active context compact", async () => {
    const pi = createPi();
    const runFormat = vi.fn(() => ({
      pid: 1,
      output: [null, "", "fmt failed"],
      stdout: "",
      stderr: "fmt failed",
      status: 1,
      signal: null,
    }));

    registerDevToolsLifecycle(pi as any, {
      resolveFormatBinary: () => "terraform",
      runFormat,
      defer: (callback) => callback(),
    });

    await pi.emit(PiEvent.SessionStart);
    await pi.emit(PiEvent.ToolResult, {
      toolName: "write",
      input: { path: "/repo/main.tf" },
    });
    await pi.emit(PiEvent.AgentEnd);

    expect(runFormat).toHaveBeenCalledOnce();
    expect(pi.sent).toEqual([{
      message: expect.objectContaining({
        customType: "dev-tools-agent-end",
        display: true,
        content: expect.stringContaining("main.tf (terraform):"),
      }),
      options: undefined,
    }]);

    const [context] = await pi.emit(PiEvent.Context, {
      messages: [
        { role: "user", content: "keep" },
        { role: "custom", customType: "dev-tools-agent-end", content: "stale" },
      ],
    });

    expect(context).toEqual({
      messages: [
        { role: "user", content: "keep" },
        expect.objectContaining({
          role: "custom",
          customType: "dev-tools-agent-end",
          display: false,
          content: expect.stringContaining("fmt failed"),
        }),
      ],
    });
  });

  it("clears pending edits and active diagnostics on session start", async () => {
    const pi = createPi();
    const state = registerDevToolsLifecycle(pi as any);

    state.pendingFiles.recordToolResult({ toolName: "write", input: { path: "/repo/a.ts" } });
    state.activeAgentEndResults.set("/repo/a.ts", {
      kind: "lsp",
      backend: "typescript",
      filePath: "/repo/a.ts",
      fileName: "a.ts",
      issues: [{ severity: "error", message: "old" }],
    });

    await pi.emit(PiEvent.SessionStart);
    await pi.emit(PiEvent.AgentEnd);

    expect(state.activeAgentEndResults.size).toBe(0);
  });
});
