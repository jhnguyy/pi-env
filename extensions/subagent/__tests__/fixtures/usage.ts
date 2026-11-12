import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function priced(message: AssistantMessage, cost: number): AssistantMessage {
  return {
    ...message,
    responseId: `fixture-cost:${cost}`,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 19,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  };
}

export default function usageFixture(pi: ExtensionAPI): void {
  const provider = fauxProvider({ provider: "usage-fixture" });
  pi.registerProvider(provider.provider);
  // Faux inference estimates tokens and zeros costs; persist deterministic billed usage
  // through the native finalized-message boundary rather than mocking session statistics.
  pi.on("message_end", (event) => {
    if (
      event.message.role === "assistant" &&
      event.message.responseId?.startsWith("fixture-cost:")
    ) {
      const message = priced(event.message, Number(event.message.responseId.slice(13)));
      if (
        event.message.content.some(
          (part) => part.type === "text" && part.text === "provider-private",
        )
      ) {
        message.content = [{ type: "text", text: "child settled" }];
      }
      return { message };
    }
    return undefined;
  });
  pi.registerTool({
    name: "usage_gate",
    label: "Usage gate",
    description: "Wait for fixture cancellation",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      writeFileSync(join(ctx.cwd, "gate-entered"), "entered");
      if (!signal?.aborted)
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      return { content: [{ type: "text", text: "gate aborted" }], details: {} };
    },
  });
  pi.on("input", (event) => {
    if (event.text.startsWith("parent:") || event.text.startsWith("parent-code:")) {
      const nested = event.text.startsWith("parent-code:");
      const params = JSON.parse(event.text.slice(nested ? 12 : 7));
      const call = nested
        ? fauxToolCall("codemode", {
            code: `text(await tools.subagent(${JSON.stringify(params)}));`,
          })
        : fauxToolCall("subagent", params);
      provider.setResponses([
        priced(fauxAssistantMessage(call, { stopReason: "toolUse" }), 0.2),
        priced(fauxAssistantMessage("parent settled"), 0.3),
      ]);
    } else if (event.text === "priced gate") {
      provider.setResponses([
        priced(
          fauxAssistantMessage(fauxToolCall("usage_gate", {}), { stopReason: "toolUse" }),
          0.75,
        ),
        priced(fauxAssistantMessage("gate settled"), 0.25),
      ]);
    } else {
      provider.setResponses([
        priced(
          fauxAssistantMessage("provider-private"),
          event.text === "priced followup" ? 2.5 : 1.25,
        ),
      ]);
    }
  });
}
