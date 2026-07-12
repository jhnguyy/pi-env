import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export type ToolProgress = (message: string) => void;

export interface DomainToolContext {
  cwd: string;
  signal?: AbortSignal;
  progress?: ToolProgress;
}

export type DomainToolExecutor<Params, Details = unknown> = (
  params: Params,
  context: DomainToolContext,
) => Promise<AgentToolResult<Details>>;

export type ToolContract<Params, Details = unknown, Schema extends TSchema = TSchema> = Pick<
  ToolDefinition<Schema, Details>,
  "name" | "label" | "description" | "parameters"
> & {
  execute: DomainToolExecutor<Params, Details>;
};

export type PiToolUi<Schema extends TSchema, Details = unknown> = Pick<
  ToolDefinition<Schema, Details, any>,
  "renderCall" | "renderResult"
>;

function progressResult(message: string): AgentToolResult<{ phase: string }> {
  return { content: [{ type: "text", text: message }], details: { phase: message } };
}

export function toPiTool<Params, Details = unknown, Schema extends TSchema = TSchema>(
  contract: ToolContract<Params, Details, Schema>,
  ui: PiToolUi<Schema, Details> = {},
): ToolDefinition<Schema, Details, any> {
  return {
    name: contract.name,
    label: contract.label,
    description: contract.description,
    parameters: contract.parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return contract.execute(params as Params, {
        cwd: ctx.cwd,
        signal,
        progress: (message) => onUpdate?.(progressResult(message) as AgentToolResult<Details>),
      });
    },
    ...ui,
  };
}

type AgentToolContextProvider = () => Pick<ExtensionContext, "cwd">;

export function toAgentTool<Params, Details = unknown>(
  contract: ToolContract<Params, Details>,
  getContext: AgentToolContextProvider,
): AgentTool<any, any> {
  return {
    name: contract.name,
    label: contract.label,
    description: contract.description,
    parameters: contract.parameters,
    execute: async (_toolCallId, params, signal, onUpdate?: AgentToolUpdateCallback) => {
      const context = getContext();
      return contract.execute(params as Params, {
        cwd: context.cwd,
        signal,
        progress: (message) => onUpdate?.(progressResult(message) as AgentToolResult<Details>),
      });
    },
  };
}
