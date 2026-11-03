import { writeFile } from "node:fs/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerNativeDagFixture(
  pi: ExtensionAPI,
  submissionPath: string,
  submission: { verdict: string; findings: string[]; snapshot: string },
): void {
  pi.registerTool({
    name: "submit_native_task",
    label: "Submit task",
    description: "Persist the fixture submission",
    parameters: Type.Object(
      {
        verdict: Type.String(),
        findings: Type.Array(Type.String()),
        snapshot: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      // A repeated execution must fail rather than silently overwrite its evidence.
      await writeFile(submissionPath, JSON.stringify(params), { flag: "wx" });
      return { content: [{ type: "text", text: "Task submission persisted" }], details: {} };
    },
  });
  const task = fauxProvider({ provider: "dag-task-fixture" });
  pi.registerProvider(task.provider);
  const defaults = fauxProvider({ provider: "dag-default-fixture" });
  defaults.setResponses([fauxAssistantMessage("Native default without tools")]);
  pi.registerProvider({
    ...defaults.provider,
    stream(...args) {
      pi.appendEntry("fixture-provider-request", {});
      return defaults.provider.stream(...args);
    },
    streamSimple(...args) {
      pi.appendEntry("fixture-provider-request", {});
      return defaults.provider.streamSimple(...args);
    },
  });
  pi.on("input", (event) => {
    task.setResponses(
      event.text === "Human continuation\nkeep original DAG result"
        ? [fauxAssistantMessage("Human continuation complete")]
        : [
            fauxAssistantMessage(fauxToolCall("submit_native_task", submission), {
              stopReason: "toolUse",
            }),
            fauxAssistantMessage("Initial task submitted"),
          ],
    );
  });
}
