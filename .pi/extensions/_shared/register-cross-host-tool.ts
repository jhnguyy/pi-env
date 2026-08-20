import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import {
  registerAgentToolsOnSessionStart,
  type AgentToolEvents,
  type AgentToolFactoryContext,
  type ToolCapability,
} from "./agent-tools";
import { toAgentTool, toPiTool, type PiToolUi, type ToolContract } from "./tool-contract";

export interface CrossHostToolRegistration<Params, Details, Schema extends TSchema> {
  readonly contract: ToolContract<Params, Details, Schema>;
  readonly capabilities: readonly [ToolCapability, ...ToolCapability[]];
  readonly piTool: ToolDefinition<Schema, Details, any>;
  readonly createAgentTool: (context: AgentToolFactoryContext) => AgentTool<any, any>;
}

interface PiRegistrationHost {
  registerTool(tool: ToolDefinition<any, any, any>): void;
}

type PiOnlyOptions<Schema extends TSchema, Details> = PiToolUi<Schema, Details> & {
  promptSnippet?: string;
  promptGuidelines?: string | string[];
};

function toMainSessionContext(ctx: ExtensionContext): Pick<ExtensionContext, "cwd"> {
  return { cwd: ctx.cwd };
}

export function registerCrossHostTool<Params, Details = unknown, Schema extends TSchema = TSchema>(
  pi: AgentToolEvents & PiRegistrationHost,
  options: {
    contract: ToolContract<Params, Details, Schema>;
    capabilities: readonly [ToolCapability, ...ToolCapability[]];
    piOptions?: PiOnlyOptions<Schema, Details>;
  },
): CrossHostToolRegistration<Params, Details, Schema> {
  const { contract, capabilities, piOptions } = options;
  const piTool = {
    ...toPiTool(contract, piOptions),
    promptSnippet: piOptions?.promptSnippet,
    promptGuidelines: piOptions?.promptGuidelines,
  } as ToolDefinition<Schema, Details, any>;

  const createAgentTool = (context: AgentToolFactoryContext): AgentTool<any, any> =>
    toAgentTool(contract, () => context.parentContext ?? { cwd: context.cwd });

  pi.registerTool(piTool);
  registerAgentToolsOnSessionStart(pi, (_sessionGeneration, ctx) => ({
    tool: toAgentTool(contract, () => toMainSessionContext(ctx)),
    capabilities: [...capabilities],
    createTool: createAgentTool,
  }));

  return {
    contract,
    capabilities,
    piTool,
    createAgentTool,
  };
}
