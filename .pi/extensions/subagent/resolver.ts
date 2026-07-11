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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { ToolCapability } from "./types";

export interface SubagentParams {
  /** Human-readable child-session name; required by the public tool schema and persisted as `sub-<slug>`. */
  name?: string;
  agent?: string;
  task: string;
  tools?: string[];
  model?: string;
  system_prompt?: string;
  max_turns?: number;
}

export interface ToolDef {
  factory: (cwd: string) => AgentTool<any, any>;
  capabilities: ToolCapability[];
}

export const BUILT_IN_TOOLS: Record<string, ToolDef> = {
  read:  { factory: (cwd) => createReadTool(cwd) as AgentTool<any, any>,  capabilities: [ToolCapability.Read] },
  bash:  { factory: (cwd) => createBashTool(cwd) as AgentTool<any, any>,  capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute] },
  edit:  { factory: (cwd) => createEditTool(cwd) as AgentTool<any, any>,  capabilities: [ToolCapability.Write] },
  write: { factory: (cwd) => createWriteTool(cwd) as AgentTool<any, any>, capabilities: [ToolCapability.Write] },
  grep:  { factory: (cwd) => createGrepTool(cwd) as AgentTool<any, any>,  capabilities: [ToolCapability.Read] },
  find:  { factory: (cwd) => createFindTool(cwd) as AgentTool<any, any>,  capabilities: [ToolCapability.Read] },
  ls:    { factory: (cwd) => createLsTool(cwd) as AgentTool<any, any>,    capabilities: [ToolCapability.Read] },
};

export type AgentConfig = ReturnType<typeof discoverAgents>["agents"][number];

export const ResolutionErrorReason = {
  AgentNotFound: "agent_not_found",
  NoTools: "no_tools",
  InvalidTools: "invalid_tools",
  NoModel: "no_model",
  ModelNotFound: "model_not_found",
} as const;
export type ResolutionErrorReason = typeof ResolutionErrorReason[keyof typeof ResolutionErrorReason];

export const ResolutionResultTag = {
  Ok: "ResolutionOk",
  Error: "ResolutionError",
} as const;
export type ResolutionResultTag = typeof ResolutionResultTag[keyof typeof ResolutionResultTag];

export interface ResolutionError {
  reason: ResolutionErrorReason;
  message: string;
  toolNames: string[];
  modelOverride?: string;
}

export type ResolutionResult<T> =
  | { _tag: typeof ResolutionResultTag.Ok; value: T }
  | { _tag: typeof ResolutionResultTag.Error; error: ResolutionError };

export function resolutionOk<T>(value: T): ResolutionResult<T> {
  return { _tag: ResolutionResultTag.Ok, value };
}

export function resolutionError<T>(error: ResolutionError): ResolutionResult<T> {
  return { _tag: ResolutionResultTag.Error, error };
}

export function isResolutionOk<T>(result: ResolutionResult<T>): result is Extract<ResolutionResult<T>, { _tag: typeof ResolutionResultTag.Ok }> {
  return result._tag === ResolutionResultTag.Ok;
}

export interface AgentResolution {
  agentConfig?: AgentConfig;
}

export interface ToolResolution {
  tools: AgentTool<any, any>[];
  toolNames: string[];
}

export interface ModelResolution {
  model: unknown;
  modelStr: string;
}

export interface SubagentExecutionPlan {
  agentConfig?: AgentConfig;
  tools: AgentTool<any, any>[];
  toolNames: string[];
  model: unknown;
  systemPrompt: string;
}

export function resolveAgentConfig(
  params: SubagentParams,
  cwd: string,
): ResolutionResult<AgentResolution> {
  if (!params.agent) return resolutionOk({});

  const discovery = discoverAgents(cwd, "both");
  const agentConfig = discovery.agents.find((a) => a.name === params.agent);
  if (!agentConfig) {
    const available = discovery.agents.map((a) => a.name).join(", ") || "none";
    return resolutionError({
      reason: ResolutionErrorReason.AgentNotFound,
      message: `Agent not found: "${params.agent}". Available: ${available}`,
      toolNames: [],
      modelOverride: params.model,
    });
  }

  return resolutionOk({ agentConfig });
}

export function resolveTools(
  params: SubagentParams,
  agentConfig: AgentConfig | undefined,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  cwd: string,
): ResolutionResult<ToolResolution> {
  // Two mechanisms, unioned when both present:
  //   capabilities: include all tools whose capability tags are a subset of the requested set.
  //   tools: include specific tools by name.
  const requestedCaps = agentConfig?.capabilities;
  const rawToolNames: string[] | undefined = agentConfig?.tools ?? params.tools;

  if ((!rawToolNames || rawToolNames.length === 0) && (!requestedCaps || requestedCaps.length === 0)) {
    return resolutionError({
      reason: ResolutionErrorReason.NoTools,
      message: "No tools or capabilities specified. Provide tools/capabilities in the agent file or pass the tools parameter.",
      toolNames: [],
      modelOverride: params.model,
    });
  }

  const resolvedToolNames = new Set<string>();

  if (requestedCaps && requestedCaps.length > 0) {
    const capSet = new Set(requestedCaps);
    for (const [toolName, def] of Object.entries(BUILT_IN_TOOLS)) {
      if (def.capabilities.every((c) => capSet.has(c))) resolvedToolNames.add(toolName);
    }
    for (const [toolName, registration] of registeredExtTools) {
      if (registration.capabilities.every((capability) => capSet.has(capability))) {
        resolvedToolNames.add(toolName);
      }
    }
  }

  if (rawToolNames) {
    for (const name of rawToolNames) resolvedToolNames.add(name);
  }

  const tools: AgentTool<any, any>[] = [];
  const unknownTools: string[] = [];
  for (const name of resolvedToolNames) {
    if (name in BUILT_IN_TOOLS) tools.push(BUILT_IN_TOOLS[name].factory(cwd));
    else if (registeredExtTools.has(name)) tools.push(registeredExtTools.get(name)!.tool);
    else unknownTools.push(name);
  }

  const toolNames = [...resolvedToolNames];
  const explicitUnknowns = unknownTools.filter((name) => rawToolNames?.includes(name));
  if (explicitUnknowns.length > 0) {
    const available = [...Object.keys(BUILT_IN_TOOLS), ...registeredExtTools.keys()].join(", ");
    return resolutionError({
      reason: ResolutionErrorReason.InvalidTools,
      message: `Unknown tools: ${explicitUnknowns.join(", ")}. Available: ${available}`,
      toolNames: rawToolNames ?? [],
      modelOverride: params.model,
    });
  }

  return resolutionOk({ tools, toolNames });
}

export function resolveModel(
  modelStr: string | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
  toolNames: string[],
): ResolutionResult<ModelResolution> {
  if (!modelStr) {
    return resolutionError({
      reason: ResolutionErrorReason.NoModel,
      message: "No model specified. Provide model in the agent file or pass the model parameter.",
      toolNames,
    });
  }

  let model: unknown;
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    model = modelRegistry.find(modelStr.slice(0, slashIdx), modelStr.slice(slashIdx + 1));
  } else {
    const available = modelRegistry.getAvailable ? modelRegistry.getAvailable() : [];
    model = available.find((candidate: any) => candidate.id === modelStr || candidate.id.includes(modelStr));
  }

  if (!model) {
    return resolutionError({
      reason: ResolutionErrorReason.ModelNotFound,
      message: `Model not found: "${modelStr}". Check the model ID and provider name.`,
      toolNames,
      modelOverride: modelStr,
    });
  }

  return resolutionOk({ model, modelStr });
}

export function resolveSystemPrompt(params: SubagentParams, agentConfig?: AgentConfig): string {
  return params.system_prompt ?? agentConfig?.systemPrompt ?? "Complete the task using only the tools provided. Be concise and direct.";
}

export function resolveSubagentExecutionPlan(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): ResolutionResult<SubagentExecutionPlan> {
  const agent = resolveAgentConfig(params, ctx.cwd);
  if (!isResolutionOk(agent)) return agent;

  const tools = resolveTools(params, agent.value.agentConfig, registeredExtTools, ctx.cwd);
  if (!isResolutionOk(tools)) return tools;

  const model = resolveModel(params.model ?? agent.value.agentConfig?.model, ctx.modelRegistry, tools.value.toolNames);
  if (!isResolutionOk(model)) return model;

  return resolutionOk({
    agentConfig: agent.value.agentConfig,
    tools: tools.value.tools,
    toolNames: tools.value.toolNames,
    model: model.value.model,
    systemPrompt: resolveSystemPrompt(params, agent.value.agentConfig),
  });
}
