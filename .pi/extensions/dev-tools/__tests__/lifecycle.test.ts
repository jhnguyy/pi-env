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
  it("records edited files, sends deferred post-edit diagnostics, and keeps active context compact", async () => {
    const pi = createPi();
    const runDiagnostics = vi.fn(async (paths: string[]) => ({
      action: "diagnostics" as const,
      path: "",
      errorCount: 1,
      warnCount: 0,
      language: "typescript",
      items: [],
      files: paths.map((path) => ({
        action: "diagnostics" as const,
        path,
        language: "typescript",
        errorCount: 1,
        warnCount: 0,
        items: [{ severity: "error" as const, line: 2, character: 3, code: "TS1", message: "broken" }],
      })),
    }));

    registerDevToolsLifecycle(pi as any, {
      runDiagnostics,
      defer: (callback) => callback(),
    });

    await pi.emit(PiEvent.SessionStart);
    await pi.emit(PiEvent.ToolResult, {
      toolName: "write",
      input: { path: "/repo/a.ts" },
    });
    await pi.emit(PiEvent.AgentEnd);

    expect(runDiagnostics).toHaveBeenCalledWith(["/repo/a.ts"]);
    expect(pi.sent).toEqual([{ 
      message: expect.objectContaining({
        customType: "dev-tools-agent-end",
        display: true,
        content: expect.stringContaining("a.ts (typescript):"),
      }),
      options: { triggerTurn: true, deliverAs: "followUp" },
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
          content: expect.stringContaining("TS1 broken"),
        }),
      ],
    });
  });

  it("clears pending edits and active diagnostics on session start", async () => {
    const pi = createPi();
    const runDiagnostics = vi.fn(async () => ({
      action: "diagnostics" as const,
      path: "/repo/a.ts",
      language: "typescript",
      errorCount: 0,
      warnCount: 0,
      items: [],
    }));
    const state = registerDevToolsLifecycle(pi as any, { runDiagnostics });

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

    expect(runDiagnostics).not.toHaveBeenCalled();
    expect(state.activeAgentEndResults.size).toBe(0);
  });
});
