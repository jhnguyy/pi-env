import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { ToolCapability, type ToolCapability as ToolCapabilityType } from "./agent-tools";

interface BuiltInToolContract {
  capabilities: ToolCapabilityType[];
  agentFactory: (cwd: string) => AgentTool<any, any>;
}

export const BUILT_IN_TOOL_CONTRACTS = {
  read: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createReadTool(cwd) as AgentTool<any, any>,
  },
  bash: {
    capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
    agentFactory: (cwd) => createBashTool(cwd) as AgentTool<any, any>,
  },
  edit: {
    capabilities: [ToolCapability.Write],
    agentFactory: (cwd) => createEditTool(cwd) as AgentTool<any, any>,
  },
  write: {
    capabilities: [ToolCapability.Write],
    agentFactory: (cwd) => createWriteTool(cwd) as AgentTool<any, any>,
  },
  grep: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createGrepTool(cwd) as AgentTool<any, any>,
  },
  find: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createFindTool(cwd) as AgentTool<any, any>,
  },
  ls: {
    capabilities: [ToolCapability.Read],
    agentFactory: (cwd) => createLsTool(cwd) as AgentTool<any, any>,
  },
} as const satisfies Record<string, BuiltInToolContract>;
