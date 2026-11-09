import { existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function jobLifetimeFixture(pi: ExtensionAPI) {
  const provider = fauxProvider({ provider: "job-lifetime" });
  pi.registerProvider(provider.provider);
  for (const name of ["child_gate", "parent_gate"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Wait for the fixture owner to release work",
      parameters: Type.Object({ marker: Type.String() }),
      async execute(_id, { marker }, signal, _update, ctx) {
        appendFileSync(join(ctx.cwd, `entered-${marker}`), "entered\n");
        while (!existsSync(join(ctx.cwd, `release-${marker}`)) && !signal?.aborted) {
          await setTimeout(5);
        }
        writeFileSync(join(ctx.cwd, `settled-${marker}`), signal?.aborted ? "aborted" : "released");
        return { content: [{ type: "text", text: "gate settled" }], details: {} };
      },
    });
  }
  pi.on("input", (event) => {
    if (event.text.startsWith("launch ")) {
      const starts = ["first", "second"].map((marker) => ({
        action: "start",
        name: marker,
        task: `child ${marker}`,
        tools: ["child_gate"],
      }));
      const calls = event.text.includes("codemode")
        ? [
            fauxToolCall("codemode", {
              code: starts
                .map((params) => `text(await tools.subagent(${JSON.stringify(params)}));`)
                .join("\n"),
            }),
          ]
        : starts.map((params) => fauxToolCall("subagent", params));
      provider.setResponses([
        fauxAssistantMessage(calls, { stopReason: "toolUse" }),
        ...(event.text.includes("interrupt")
          ? [
              fauxAssistantMessage(fauxToolCall("parent_gate", { marker: "parent" }), {
                stopReason: "toolUse",
              }),
            ]
          : []),
        fauxAssistantMessage("Parent ready"),
      ]);
    } else if (event.text.startsWith("child ")) {
      const marker = event.text.slice(6);
      provider.setResponses([
        fauxAssistantMessage(fauxToolCall("child_gate", { marker }), { stopReason: "toolUse" }),
        fauxAssistantMessage(`answer ${marker}`),
      ]);
    } else if (event.text.startsWith("operations:")) {
      const operations = JSON.parse(event.text.slice(11)) as { action: string; job_id: string }[];
      provider.setResponses([
        fauxAssistantMessage(
          operations.map((params) => fauxToolCall("subagent", params)),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Operations retrieved"),
      ]);
    } else {
      provider.setResponses([fauxAssistantMessage("Next parent reply")]);
    }
  });
}
