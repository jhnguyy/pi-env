import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents, type AgentScope, type AgentSource } from "./agents";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { WorkspaceAccess, type WorkspaceAccess as WorkspaceAccessValue } from "./control";
import { BUILT_IN_TOOL_CONTRACTS } from "../_shared/built-in-tools";
import {
  ResolutionErrorReason,
  ToolCapability,
  type ResolutionErrorReason as ResolutionErrorReasonValue,
} from "./types";

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
  /** Project agents require both explicit project scope and a trusted project. */
  agent_scope?: AgentScope;
  /** Select an exact origin when agents from more than one source have the same name. */
  agent_source?: AgentSource;
  /** Write/execute tools serialize by canonical workspace unless isolation is required. */
  workspace_policy?: "read-only" | "serialize-write" | "isolated-write";
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

export { ResolutionErrorReason } from "./types";

export const ResolutionResultTag = {
  Ok: "ResolutionOk",
  Error: "ResolutionError",
} as const;
export type ResolutionResultTag = (typeof ResolutionResultTag)[keyof typeof ResolutionResultTag];

export interface ResolutionError {
  reason: ResolutionErrorReasonValue;
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
  workspaceAccess: WorkspaceAccessValue;
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
  workspaceAccess: WorkspaceAccessValue;
}

export function resolveEffectiveCwd(
  params: SubagentParams,
  ctxCwd: string,
): ResolutionResult<string> {
  if (!params.cwd) {
    try {
      return resolutionOk(realpathSync(ctxCwd));
    } catch {
      return resolutionOk(ctxCwd);
    }
  }
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

  const scope = params.agent_scope ?? (params.agent_source === "project" ? "project" : "user");
  const discovery = discoverAgents(cwd, scope);
  const candidates = params.agent_source ? discovery.candidates : discovery.agents;
  const agentConfig = candidates.find(
    (candidate) =>
      candidate.name === params.agent &&
      (params.agent_source === undefined || candidate.source === params.agent_source),
  );
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

function materializeTool(
  entry: ToolCatalogEntry,
  cwd: string,
  parentContext: ExtensionContext,
): AgentTool<any, any> {
  if (entry._tag === "built-in") return entry.definition.factory(cwd);
  return entry.registration.createTool?.({
    cwd,
    sessionGeneration: entry.registration.sessionGeneration ?? "legacy",
    parentContext,
  }) ?? { ...entry.registration.tool };
}

function entryCapabilities(entry: ToolCatalogEntry): readonly ToolCapability[] {
  return entry._tag === "built-in" ? entry.definition.capabilities : entry.registration.capabilities;
}

function materializeToolResolution(
  names: ReadonlySet<string>,
  explicitNames: readonly string[],
  catalog: ToolCatalog,
  cwd: string,
  modelOverride: string | undefined,
  parentContext: ExtensionContext,
): ResolutionResult<ToolResolution> {
  const explicitNameSet = new Set(explicitNames);
  const tools: AgentTool<any, any>[] = [];
  const capabilities = new Set<ToolCapability>();
  const unknownExplicitNames: string[] = [];

  for (const name of names) {
    const entry = catalog.byName.get(name);
    if (entry) {
      tools.push(materializeTool(entry, cwd, parentContext));
      for (const capability of entryCapabilities(entry)) capabilities.add(capability);
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
  const workspaceAccess =
    capabilities.has(ToolCapability.Write) || capabilities.has(ToolCapability.Execute)
      ? WorkspaceAccess.Write
      : WorkspaceAccess.Read;
  return resolutionOk({ tools, toolNames: [...names], workspaceAccess });
}

export function resolveTools(
  params: SubagentParams,
  agentConfig: AgentConfig | undefined,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  cwd: string,
  parentContext?: ExtensionContext,
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
  return materializeToolResolution(
    names,
    explicitNames,
    catalog,
    cwd,
    params.model,
    parentContext ?? ({ cwd } as ExtensionContext),
  );
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

function gitWorkspaceRoot(cwd: string): { root: string; linked: boolean } | undefined {
  let current = cwd;
  while (true) {
    try {
      const gitEntry = statSync(join(current, ".git"));
      return { root: current, linked: gitEntry.isFile() };
    } catch {}
    const parent = join(current, "..");
    let canonicalParent = parent;
    try {
      canonicalParent = realpathSync(parent);
    } catch {}
    if (canonicalParent === current) return undefined;
    current = canonicalParent;
  }
}

function workspacePolicyError(
  params: SubagentParams,
  ctx: ExtensionContext,
  tools: ToolResolution,
  effectiveCwd: string,
  agentConfig: AgentConfig | undefined,
): ResolutionError | undefined {
  const policy = params.workspace_policy ?? agentConfig?.workspacePolicy ?? "serialize-write";
  if (tools.workspaceAccess === WorkspaceAccess.Read) return undefined;
  if (policy === "read-only") {
    return {
      reason: ResolutionErrorReason.UnsafeWorkspace,
      message: "Write or execute tools are not allowed by the read-only workspace policy.",
      toolNames: tools.toolNames,
      modelOverride: params.model,
    };
  }
  if (policy !== "isolated-write") return undefined;
  let parentCwd = ctx.cwd;
  try {
    parentCwd = realpathSync(ctx.cwd);
  } catch {}
  const childWorkspace = gitWorkspaceRoot(effectiveCwd);
  const parentWorkspace = gitWorkspaceRoot(parentCwd);
  if (
    !childWorkspace?.linked ||
    childWorkspace.root === parentWorkspace?.root
  ) {
    return {
      reason: ResolutionErrorReason.UnsafeWorkspace,
      message: "The isolated-write policy requires a linked Git worktree separate from the parent cwd.",
      toolNames: tools.toolNames,
      modelOverride: params.model,
    };
  }
  return undefined;
}

export function resolveSubagentExecutionPlan(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): ResolutionResult<SubagentExecutionPlan> {
  if (
    params.agent &&
    (params.agent_scope === "project" ||
      params.agent_scope === "both" ||
      params.agent_source === "project") &&
    ctx.isProjectTrusted?.() !== true
  ) {
    return resolutionError({
      reason: ResolutionErrorReason.UntrustedProjectAgent,
      message: "Project agents require an explicit project scope and a trusted project.",
      toolNames: [],
      modelOverride: params.model,
    });
  }

  const effectiveCwd = resolveEffectiveCwd(params, ctx.cwd);
  if (!isResolutionOk(effectiveCwd)) return effectiveCwd;

  const agent = resolveAgentConfig(params, effectiveCwd.value);
  if (!isResolutionOk(agent)) return agent;

  const tools = resolveTools(
    params,
    agent.value.agentConfig,
    registeredExtTools,
    effectiveCwd.value,
    ctx,
  );
  if (!isResolutionOk(tools)) return tools;
  const unsafeWorkspace = workspacePolicyError(
    params,
    ctx,
    tools.value,
    effectiveCwd.value,
    agent.value.agentConfig,
  );
  if (unsafeWorkspace) return resolutionError(unsafeWorkspace);

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
    workspaceAccess: tools.value.workspaceAccess,
  });
}
