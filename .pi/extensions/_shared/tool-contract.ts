import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export interface ToolContract<Params, Details = unknown, Schema extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  execute: DomainToolExecutor<Params, Details>;
}

export type PiToolUi<Params, Details = unknown> = Pick<
  Parameters<ExtensionAPI["registerTool"]>[0],
  "renderCall" | "renderResult"
>;

function progressResult(message: string): AgentToolResult<{ phase: string }> {
  return { content: [{ type: "text", text: message }], details: { phase: message } };
}

export function toPiTool<Params, Details = unknown>(
  contract: ToolContract<Params, Details>,
  ui: PiToolUi<Params, Details> = {},
): Parameters<ExtensionAPI["registerTool"]>[0] {
  return {
    name: contract.name,
    label: contract.label,
    description: contract.description,
    parameters: contract.parameters as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return contract.execute(params as Params, {
        cwd: ctx.cwd,
        signal,
        progress: (message) => onUpdate?.(progressResult(message)),
      });
    },
    ...ui,
  };
}

export interface AgentToolAdapterContext {
  cwd: string;
}

export type AgentToolContextProvider = () => AgentToolAdapterContext;

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
        progress: (message) => onUpdate?.(progressResult(message)),
      });
    },
  };
}

export function contextFromPiSession(ctx: ExtensionContext): AgentToolAdapterContext {
  return { cwd: ctx.cwd };
}
