import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { toPiTool, type PublicPiToolUi, type ToolContract } from "./tool-contract";
import { registerPublicTool, type PublicPiToolDefinition } from "./tool-render";

interface PiRegistrationHost {
  registerTool(tool: ToolDefinition<any, any, any>): void;
}

type PiOnlyOptions<Schema extends TSchema, Details> = PublicPiToolUi<Schema, Details> & {
  promptSnippet?: string;
  promptGuidelines?: string[];
  exposure?: ToolDefinition["exposure"];
  namespace?: ToolDefinition["namespace"];
};

export function registerContractTool<Params, Details = unknown, Schema extends TSchema = TSchema>(
  pi: PiRegistrationHost,
  options: {
    contract: ToolContract<Params, Details, Schema>;
    piOptions: PiOnlyOptions<Schema, Details>;
  },
): void {
  const { contract, piOptions } = options;
  const piTool: PublicPiToolDefinition<Schema, Details, any> = {
    ...toPiTool(contract, piOptions),
    promptSnippet: piOptions.promptSnippet,
    promptGuidelines: piOptions.promptGuidelines,
    exposure: piOptions.exposure,
    namespace: piOptions.namespace,
    renderCall: piOptions.renderCall,
    renderResult: piOptions.renderResult,
  };

  registerPublicTool(pi, piTool);
}
