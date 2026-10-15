import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { discoverAgents, type AgentScope } from "./agents";
import { WorkspaceAccess, type WorkspaceAccess as WorkspaceAccessValue } from "./control";
import {
  ResolutionErrorReason,
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
  /** Optional absolute working directory for child discovery, tools, and execution. */
  cwd?: string;
  /** Project agents require both explicit project scope and a trusted project. */
  agent_scope?: AgentScope;
}

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

export interface SubagentExecutionPlan {
  agentConfig?: AgentConfig;
  toolNames?: readonly string[];
  modelOverride?: string;
  systemPrompt?: string;
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

  const discovery = discoverAgents(cwd, params.agent_scope ?? "user");
  const agentConfig = discovery.agents.find((candidate) => candidate.name === params.agent);
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

export function isProjectTrustedForCwd(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, cwd: string): boolean {
  const parentCwd = resolveEffectiveCwd({ task: "" }, ctx.cwd);
  if (isResolutionOk(parentCwd) && parentCwd.value === cwd) {
    return ctx.isProjectTrusted?.() === true;
  }
  return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
}

/** Discovery only; native child services own tool and model resolution. */
export function resolveSubagentExecutionPlan(
  params: SubagentParams,
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): ResolutionResult<SubagentExecutionPlan> {
  const cwd = resolveEffectiveCwd(params, ctx.cwd);
  if (!isResolutionOk(cwd)) return cwd;
  if (params.agent && params.agent_scope === "project" && !isProjectTrustedForCwd(ctx, cwd.value)) {
    return resolutionError({
      reason: ResolutionErrorReason.UntrustedProjectAgent,
      message: "Project agents require an explicit project scope and a trusted project.",
      toolNames: [],
    });
  }
  const agent = resolveAgentConfig(params, cwd.value);
  if (!isResolutionOk(agent)) return agent;
  const config = agent.value.agentConfig;
  if (params.tools === undefined && config?.tools === undefined && config?.capabilities?.length) {
    return resolutionError({ reason: ResolutionErrorReason.InvalidTools, message: `Agent "${config.name}" uses legacy capabilities without native tools. Select tools explicitly; capabilities do not limit native defaults.`, toolNames: [] });
  }
  return resolutionOk({
    agentConfig: config,
    toolNames: params.tools ?? config?.tools,
    modelOverride: params.model ?? config?.model,
    systemPrompt: params.system_prompt ?? config?.systemPrompt,
    effectiveCwd: cwd.value,
    workspaceAccess: WorkspaceAccess.Write,
  });
}
