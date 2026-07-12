import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ToolCapability, type ToolCapability as ToolCapabilityType } from "./agent-tools";

interface BuiltInToolContract {
  capabilities: ToolCapabilityType[];
  agentFactory: (cwd: string) => AgentTool<any, any>;
  definitionFactory: (cwd: string) => ToolDefinition<any, any, any>;
}

export const BUILT_IN_TOOL_CONTRACTS = {
  read: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createReadTool(cwd) as AgentTool<any, any>,
    definitionFactory: createReadToolDefinition,
  },
  bash: {
    capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
    agentFactory: (cwd) => createBashTool(cwd) as AgentTool<any, any>,
    definitionFactory: createBashToolDefinition,
  },
  edit: {
    capabilities: [ToolCapability.Write],
    agentFactory: (cwd) => createEditTool(cwd) as AgentTool<any, any>,
    definitionFactory: createEditToolDefinition,
  },
  write: {
    capabilities: [ToolCapability.Write],
    agentFactory: (cwd) => createWriteTool(cwd) as AgentTool<any, any>,
    definitionFactory: createWriteToolDefinition,
  },
  grep: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createGrepTool(cwd) as AgentTool<any, any>,
    definitionFactory: createGrepToolDefinition,
  },
  find: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createFindTool(cwd) as AgentTool<any, any>,
    definitionFactory: createFindToolDefinition,
  },
  ls: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createLsTool(cwd) as AgentTool<any, any>,
    definitionFactory: createLsToolDefinition,
  },
} as const satisfies Record<string, BuiltInToolContract>;

export const BUILT_IN_TOOL_NAMES = new Set<string>(Object.keys(BUILT_IN_TOOL_CONTRACTS));
