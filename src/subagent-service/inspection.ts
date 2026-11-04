import type { NativeChildSnapshot } from "../../.pi/extensions/subagent/child-types.js";
import { childMessagesText, plainChildText } from "../../.pi/extensions/subagent/transcript.js";
import type { InspectionOptions, InspectionPage } from "./contract.js";
import { pageText } from "./pagination.js";

function configurationText(child: NativeChildSnapshot): string {
  return `Child: ${child.id}\nParent operation: ${child.runId}\nCwd: ${child.cwd}\nModel: ${child.model ?? "unavailable"}\nNative session: ${child.sessionFile ?? "unavailable"}\n\nActive tools\n${child.activeTools.join("\n") || "(none)"}\n\nCallable tools\n${child.callableTools.join("\n") || "(none)"}\n\nInitial result\n${child.initialResult ? (child.initialResult.isError ? "Failed" : "Completed") : "Pending"}\n\nHistorical owners require explicit reopen. Never open an external transcript writer while the service owns this child.`;
}

/** Select and page on the owner side; no native messages or tool details cross the link. */
export function inspectionPage(
  child: NativeChildSnapshot,
  options: InspectionOptions = {},
): InspectionPage {
  const view = options.view ?? "conversation";
  let text: string;
  switch (view) {
    case "instructions":
      text = `Original coordinator task\n${child.task}\n\nNative system prompt\n${child.systemPrompt}`;
      break;
    case "configuration":
      text = configurationText(child);
      break;
    case "provenance":
      text =
        child.inputs
          .map((input) => `${input.source} · ${input.mode} · ${input.at}\n${input.text}`)
          .join("\n\n") || "No recorded inputs.";
      break;
    case "conversation":
      text = `Native conversation (bounded recent context; compaction may summarize earlier messages)\n\n${childMessagesText(child.messages)}`;
  }
  const page = pageText(plainChildText(text), options);
  return {
    id: child.id,
    runId: child.runId,
    name: child.name.slice(0, 128),
    task: child.task.slice(0, 256),
    cwd: child.cwd,
    sessionFile: child.sessionFile,
    model: child.model?.slice(0, 256),
    state: child.state,
    view,
    ...page,
  };
}
