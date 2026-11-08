import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import type * as ToolTypes from "./tool-types";
export type {
  DomainToolContext,
  DomainToolExecutor,
  DomainToolResult,
  ToolContract,
  ToolProgress,
} from "./tool-types";

export type PiToolUi<Schema extends TSchema, Details = unknown> = Pick<
  ToolDefinition<Schema, Details, any>,
  "renderCall" | "renderResult"
>;
export type PublicPiToolUi<Schema extends TSchema, Details = unknown> = Required<
  PiToolUi<Schema, Details>
>;

function progressResult(message: string): AgentToolResult<{ phase: string }> {
  return { content: [{ type: "text", text: message }], details: { phase: message } };
}

export function toPiTool<Params, Details = unknown, Schema extends TSchema = TSchema>(
  contract: ToolTypes.ToolContract<Params, Details, Schema>,
  ui: PiToolUi<Schema, Details> = {},
): ToolDefinition<Schema, Details, any> {
  return {
    name: contract.name,
    label: contract.label,
    description: contract.description,
    parameters: contract.parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return contract.execute(params, {
        cwd: ctx.cwd,
        signal,
        progress: (message) => onUpdate?.(progressResult(message) as AgentToolResult<Details>),
      });
    },
    ...ui,
  };
}
