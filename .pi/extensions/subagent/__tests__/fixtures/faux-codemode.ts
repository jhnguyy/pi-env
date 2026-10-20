import { setTimeout as delay } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";

const MAX_CAPACITY_RETRIES = 5;
const CAPACITY_BACKOFF_MS = 25;

// Codemode documents transient capacity failures while previous workers exit.
// Retry only this preflight failure: replaying a script with tool calls could
// duplicate effects. Other errors remain visible to the scenario assertions.
export function afterCodemode(
  provider: FauxProviderHandle,
  code: string,
  [next, ...remaining]: [AssistantMessage, ...AssistantMessage[]],
): FauxResponseFactory {
  let retries = 0;
  const continuation: FauxResponseFactory = async (context, options) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult" && last.toolName === "codemode" && last.isError) {
      const output = last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const details = last.details;
      if (
        output.includes("Codemode worker limit reached") &&
        output.includes("No tool calls were made.") &&
        details !== null &&
        typeof details === "object" &&
        "calls" in details &&
        Array.isArray(details.calls) &&
        details.calls.length === 0
      ) {
        if (++retries > MAX_CAPACITY_RETRIES)
          throw new Error("Scripted model exhausted preflight worker-capacity retries");
        await delay(CAPACITY_BACKOFF_MS * retries, undefined, { signal: options?.signal });
        provider.setResponses([continuation]);
        return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
      }
    }
    provider.setResponses(remaining);
    return next;
  };
  return continuation;
}
