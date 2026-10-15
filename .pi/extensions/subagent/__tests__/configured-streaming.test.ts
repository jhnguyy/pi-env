import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runResolvedSubagentEffect } from "../execute";

// No credentials/network: replace only the inference boundary, retaining the native loop and persistence.
describe("configured child inference", () => {
  it("uses the configured registry and retains exactly one initial system message on exact-path reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-configured-child-"));
    try {
      const requests: Context[] = [];
      const registry = {
        getApiKeyForProvider: async () => "test-key",
        streamSimple(_model: unknown, context: Context) {
          expect(this).toBe(registry);
          requests.push(context);
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "configured answer" }],
            api: "test", provider: "configured", model: "local", stopReason: "stop", timestamp: 1,
            usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
          return stream;
        },
      } satisfies Pick<ExtensionContext["modelRegistry"], "streamSimple" | "getApiKeyForProvider">;
      const result = await Effect.runPromise(runResolvedSubagentEffect({
        name: "configured", task: "task", tools: [], toolNames: [],
        model: { provider: "configured", id: "local", api: "test" },
        systemPrompt: "exact initial prompt\n", cwd: root,
      }, { cwd: root, sessionManager: SessionManager.create(root, root), modelRegistry: registry } as any,
      { env: { OTEL_SDK_DISABLED: "true" } }));
      expect(result.details.isError).toBe(false);
      expect(result.details.finalOutput).toBe("configured answer");
      expect(requests).toHaveLength(1);
      expect(requests[0].messages[0]).toMatchObject({ role: "system", content: "exact initial prompt\n" });
      const reopened = SessionManager.open(result.details.sessionFile!);
      const messages = reopened.buildSessionContext().messages;
      expect(messages.filter((message) => message.role === "system")).toEqual([
        { role: "system", content: "exact initial prompt\n", timestamp: expect.any(Number) },
      ]);
      expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
