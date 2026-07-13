import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { BUILT_IN_TOOL_CONTRACTS } from "../_shared/built-in-tools";
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
  /** Optional absolute working directory for child discovery, tools, and execution. */
  cwd?: string;
}

export interface ToolDef {
  factory: (cwd: string) => AgentTool<any, any>;
  capabilities: ToolCapability[];
}

export const BUILT_IN_TOOLS: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(BUILT_IN_TOOL_CONTRACTS).map(([name, contract]) => [
    name,
    { factory: contract.agentFactory, capabilities: [...contract.capabilities] },
  ]),
);

export type AgentConfig = ReturnType<typeof discoverAgents>["agents"][number];

export const ResolutionErrorReason = {
  AgentNotFound: "agent_not_found",
  NoTools: "no_tools",
  InvalidTools: "invalid_tools",
  NoModel: "no_model",
  ModelNotFound: "model_not_found",
  InvalidCwd: "invalid_cwd",
} as const;
export type ResolutionErrorReason =
  (typeof ResolutionErrorReason)[keyof typeof ResolutionErrorReason];

export const ResolutionResultTag = {
  Ok: "ResolutionOk",
  Error: "ResolutionError",
} as const;
export type ResolutionResultTag = (typeof ResolutionResultTag)[keyof typeof ResolutionResultTag];

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

export function isResolutionOk<T>(
  result: ResolutionResult<T>,
): result is Extract<ResolutionResult<T>, { _tag: typeof ResolutionResultTag.Ok }> {
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
  effectiveCwd: string;
}

export function resolveEffectiveCwd(
  params: SubagentParams,
  ctxCwd: string,
): ResolutionResult<string> {
  if (!params.cwd) return resolutionOk(ctxCwd);
  if (!isAbsolute(params.cwd)) {
    return resolutionError({
      reason: ResolutionErrorReason.InvalidCwd,
      message: `Invalid cwd: "${params.cwd}" is not an absolute path.`,
      toolNames: params.tools ?? [],
      modelOverride: params.model,
    });
  }
  try {
    const canonical = realpathSync(params.cwd);
    if (!statSync(canonical).isDirectory()) {
      return resolutionError({
        reason: ResolutionErrorReason.InvalidCwd,
        message: `Invalid cwd: "${params.cwd}" is not a directory.`,
        toolNames: params.tools ?? [],
        modelOverride: params.model,
      });
    }
    return resolutionOk(canonical);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return resolutionError({
      reason: ResolutionErrorReason.InvalidCwd,
      message: `Invalid cwd: "${params.cwd}" could not be resolved: ${message}`,
      toolNames: params.tools ?? [],
      modelOverride: params.model,
    });
  }
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

type ToolCatalogEntry =
  | { _tag: "built-in"; definition: ToolDef }
  | { _tag: "extension"; registration: ExtToolRegistration };

type ToolCatalog = {
  byName: Map<string, ToolCatalogEntry>;
  availableNames: string[];
};

function buildToolCatalog(
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): ToolCatalog {
  const byName = new Map<string, ToolCatalogEntry>();
  for (const [name, definition] of Object.entries(BUILT_IN_TOOLS)) {
    byName.set(name, { _tag: "built-in", definition });
  }
  for (const [name, registration] of registeredExtTools) {
    if (!byName.has(name)) byName.set(name, { _tag: "extension", registration });
  }
  return {
    byName,
    availableNames: [...Object.keys(BUILT_IN_TOOLS), ...registeredExtTools.keys()],
  };
}

function hasRequestedCapabilities(
  capabilities: readonly ToolCapability[],
  requested: ReadonlySet<string>,
): boolean {
  for (const capability of capabilities) {
    if (!requested.has(capability)) return false;
  }
  return true;
}

function collectToolNames(
  explicitNames: readonly string[],
  requestedCapabilities: readonly string[],
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): Set<string> {
  const names = new Set<string>();
  if (requestedCapabilities.length > 0) {
    const requested = new Set(requestedCapabilities);
    for (const [name, definition] of Object.entries(BUILT_IN_TOOLS)) {
      if (hasRequestedCapabilities(definition.capabilities, requested)) names.add(name);
    }
    for (const [name, registration] of registeredExtTools) {
      if (hasRequestedCapabilities(registration.capabilities, requested)) names.add(name);
    }
  }
  for (const name of explicitNames) names.add(name);
  return names;
}

function materializeTool(entry: ToolCatalogEntry, cwd: string): AgentTool<any, any> {
  return entry._tag === "built-in" ? entry.definition.factory(cwd) : entry.registration.tool;
}

function materializeToolResolution(
  names: ReadonlySet<string>,
  explicitNames: readonly string[],
  catalog: ToolCatalog,
  cwd: string,
  modelOverride: string | undefined,
): ResolutionResult<ToolResolution> {
  const explicitNameSet = new Set(explicitNames);
  const tools: AgentTool<any, any>[] = [];
  const unknownExplicitNames: string[] = [];

  for (const name of names) {
    const entry = catalog.byName.get(name);
    if (entry) {
      tools.push(materializeTool(entry, cwd));
    } else if (explicitNameSet.has(name)) {
      unknownExplicitNames.push(name);
    }
  }

  if (unknownExplicitNames.length > 0) {
    return resolutionError({
      reason: ResolutionErrorReason.InvalidTools,
      message: `Unknown tools: ${unknownExplicitNames.join(", ")}. Available: ${catalog.availableNames.join(", ")}`,
      toolNames: [...explicitNames],
      modelOverride,
    });
  }
  return resolutionOk({ tools, toolNames: [...names] });
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
  const requestedCapabilities = agentConfig?.capabilities ?? [];
  const explicitNames = agentConfig?.tools ?? params.tools ?? [];
  if (explicitNames.length === 0 && requestedCapabilities.length === 0) {
    return resolutionError({
      reason: ResolutionErrorReason.NoTools,
      message:
        "No tools or capabilities specified. Provide tools/capabilities in the agent file or pass the tools parameter.",
      toolNames: [],
      modelOverride: params.model,
    });
  }

  const names = collectToolNames(explicitNames, requestedCapabilities, registeredExtTools);
  const catalog = buildToolCatalog(registeredExtTools);
  return materializeToolResolution(names, explicitNames, catalog, cwd, params.model);
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
    model = available.find(
      (candidate: any) => candidate.id === modelStr || candidate.id.includes(modelStr),
    );
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
  return (
    params.system_prompt ??
    agentConfig?.systemPrompt ??
    "Complete the task using only the tools provided. Be concise and direct."
  );
}

export function resolveSubagentExecutionPlan(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): ResolutionResult<SubagentExecutionPlan> {
  const effectiveCwd = resolveEffectiveCwd(params, ctx.cwd);
  if (!isResolutionOk(effectiveCwd)) return effectiveCwd;

  const agent = resolveAgentConfig(params, effectiveCwd.value);
  if (!isResolutionOk(agent)) return agent;

  const tools = resolveTools(
    params,
    agent.value.agentConfig,
    registeredExtTools,
    effectiveCwd.value,
  );
  if (!isResolutionOk(tools)) return tools;

  const model = resolveModel(
    params.model ?? agent.value.agentConfig?.model,
    ctx.modelRegistry,
    tools.value.toolNames,
  );
  if (!isResolutionOk(model)) return model;

  return resolutionOk({
    agentConfig: agent.value.agentConfig,
    tools: tools.value.tools,
    toolNames: tools.value.toolNames,
    model: model.value.model,
    systemPrompt: resolveSystemPrompt(params, agent.value.agentConfig),
    effectiveCwd: effectiveCwd.value,
  });
}
