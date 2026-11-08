import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  createNotesContract,
  NOTES_PROMPT_GUIDELINES,
  type NotesContractOptions,
  type NotesParams,
} from "./contract";
import type { NotesProvider } from "./domain";

export type { NotesProvider } from "./domain";

/** The host supplies storage and credentials; this entry point reads no CLI settings or local vault paths. */
export function createDurableNotesExtension(
  source: NotesProvider | (() => NotesProvider),
  options: NotesContractOptions = {},
) {
  const contract = createNotesContract(source, options);
  return defineExtension({
    name: "pi-env.notes",
    sections: [section("notes", () => NOTES_PROMPT_GUIDELINES.join("\n"))],
    tools: [
      defineTool({
        name: contract.name,
        description: contract.description,
        parameters: contract.parameters,
        // A single tool includes mutations. A crash must never automatically repeat an external effect.
        replay: "unsafe",
        async execute(args, api, context) {
          const agent = await api.agent(context);
          // pi-schema does not infer TypeBox 1.x enums; the host and contract validate these arguments.
          const result = await contract.execute(args as NotesParams, {
            cwd: agent.cwd ?? ".",
            signal: context.abortSignal,
            progress: (message) => api.output(message),
          });
          return {
            output: result.content,
            // Optional provider fields may be undefined; durable state must contain only JSON values.
            details: JSON.parse(JSON.stringify(result.details)) as ToolExecutionResult["details"],
          };
        },
      }),
    ],
  });
}
