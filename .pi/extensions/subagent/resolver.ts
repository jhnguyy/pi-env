import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as Control from "./control";
import * as Types from "./types";

export interface SubagentParams {
  /** Human-readable child-session name; required by the public tool schema and persisted as `sub-<slug>`. */
  name?: string;
  task: string;
  tools?: string[];
  model?: string;
  system_prompt?: string;
  /** Optional absolute working directory for child discovery, tools, and execution. */
  cwd?: string;
}

export { ResolutionErrorReason } from "./types";

export const ResolutionResultTag = {
  Ok: "ResolutionOk",
  Error: "ResolutionError",
} as const;
export type ResolutionResultTag = (typeof ResolutionResultTag)[keyof typeof ResolutionResultTag];

export interface ResolutionError {
  reason: Types.ResolutionErrorReason;
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

export interface SubagentExecutionPlan {
  toolNames?: readonly string[];
  modelOverride?: string;
  systemPrompt?: string;
  effectiveCwd: string;
  workspaceAccess: Control.WorkspaceAccess;
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
      reason: Types.ResolutionErrorReason.InvalidCwd,
      message: `Invalid cwd: "${params.cwd}" is not an absolute path.`,
      toolNames: params.tools ?? [],
      modelOverride: params.model,
    });
  }
  try {
    const canonical = realpathSync(params.cwd);
    if (!statSync(canonical).isDirectory()) {
      return resolutionError({
        reason: Types.ResolutionErrorReason.InvalidCwd,
        message: `Invalid cwd: "${params.cwd}" is not a directory.`,
        toolNames: params.tools ?? [],
        modelOverride: params.model,
      });
    }
    return resolutionOk(canonical);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return resolutionError({
      reason: Types.ResolutionErrorReason.InvalidCwd,
      message: `Invalid cwd: "${params.cwd}" could not be resolved: ${message}`,
      toolNames: params.tools ?? [],
      modelOverride: params.model,
    });
  }
}

export function isProjectTrustedForCwd(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, cwd: string): boolean {
  const parentCwd = resolveEffectiveCwd({ task: "" }, ctx.cwd);
  if (isResolutionOk(parentCwd) && parentCwd.value === cwd) {
    return ctx.isProjectTrusted?.() === true;
  }
  return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
}

/** Native child services own tool and model resolution. */
export function resolveSubagentExecutionPlan(
  params: SubagentParams,
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): ResolutionResult<SubagentExecutionPlan> {
  const cwd = resolveEffectiveCwd(params, ctx.cwd);
  if (!isResolutionOk(cwd)) return cwd;
  return resolutionOk({
    toolNames: params.tools,
    modelOverride: params.model,
    systemPrompt: params.system_prompt,
    effectiveCwd: cwd.value,
    workspaceAccess: Control.WorkspaceAccess.Write,
  });
}
