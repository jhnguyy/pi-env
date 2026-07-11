import { Effect } from "effect";
import { asyncRisksEffect, complexityEffect, duplicatesEffect, similarTypesEffect } from "./analyzers.js";
import { bundleAnalyzerEffect, dependencyAnalyzerEffect, eslintAnalyzerEffect, knipAnalyzerEffect } from "./external.js";
import { AnalyzerName, AnalyzerRunError, type Finding } from "./model.js";
import { isTypeProject, ProjectRequirement, type Project } from "./program.js";
import type { streamProcessEffect } from "./process.js";
import type { Scope } from "./scope.js";

export interface AnalyzerDescriptor {
  name: AnalyzerName;
  defaultEnabled: boolean;
  project: ProjectRequirement;
}

const ANALYZERS: readonly AnalyzerDescriptor[] = [
  { name: AnalyzerName.Complexity, defaultEnabled: true, project: ProjectRequirement.ScopedSyntax },
  { name: AnalyzerName.Duplicates, defaultEnabled: true, project: ProjectRequirement.CorpusSyntax },
  { name: AnalyzerName.Types, defaultEnabled: true, project: ProjectRequirement.Types },
  { name: AnalyzerName.AsyncRisk, defaultEnabled: true, project: ProjectRequirement.ScopedSyntax },
  { name: AnalyzerName.Eslint, defaultEnabled: true, project: ProjectRequirement.None },
  { name: AnalyzerName.Dependencies, defaultEnabled: true, project: ProjectRequirement.None },
  { name: AnalyzerName.Knip, defaultEnabled: true, project: ProjectRequirement.None },
  { name: AnalyzerName.Bundle, defaultEnabled: false, project: ProjectRequirement.None },
] as const;

const descriptorByName = new Map(ANALYZERS.map((descriptor) => [descriptor.name, descriptor]));
const requirementRank: Readonly<Record<ProjectRequirement, number>> = {
  [ProjectRequirement.None]: 0,
  [ProjectRequirement.ScopedSyntax]: 1,
  [ProjectRequirement.CorpusSyntax]: 2,
  [ProjectRequirement.Types]: 3,
};

export const defaultAnalyzerNames = ANALYZERS
  .filter((descriptor) => descriptor.defaultEnabled)
  .map((descriptor) => descriptor.name);

export function analyzerDescriptor(name: AnalyzerName): AnalyzerDescriptor {
  return descriptorByName.get(name)!;
}

export function projectRequirement(checks: readonly AnalyzerName[]): ProjectRequirement {
  let requirement: ProjectRequirement = ProjectRequirement.None;
  for (const name of checks) {
    const candidate = analyzerDescriptor(name).project;
    if (requirementRank[candidate] > requirementRank[requirement]) requirement = candidate;
  }
  return requirement;
}

export interface AnalyzerContext {
  cwd: string;
  scope: Scope;
  project?: Project;
  typeSimilarityThreshold?: number;
  maxMemoryMb: number;
  externalTimeoutMs?: number;
  beforeBundleEntry: (entrypoint: string) => boolean;
  processRunner?: typeof streamProcessEffect;
}

const analyzerError = (analyzer: AnalyzerName, cause: unknown): AnalyzerRunError =>
  cause instanceof AnalyzerRunError
    ? cause
    : new AnalyzerRunError({ analyzer, message: cause instanceof Error ? cause.message : String(cause) });

function internalEffect(name: AnalyzerName, operation: Effect.Effect<Finding[], unknown>): Effect.Effect<Finding[], AnalyzerRunError> {
  return operation.pipe(Effect.mapError((cause) => analyzerError(name, cause)));
}

export function runAnalyzer(name: AnalyzerName, context: AnalyzerContext): Effect.Effect<Finding[], AnalyzerRunError> {
  switch (name) {
    case AnalyzerName.Complexity:
      return internalEffect(name, context.project === undefined
        ? Effect.fail(new Error("Complexity analyzer requires a syntax project"))
        : complexityEffect(context.project, context.cwd, context.scope));
    case AnalyzerName.Duplicates:
      return internalEffect(name, context.project === undefined
        ? Effect.fail(new Error("Duplicate analyzer requires a syntax project"))
        : duplicatesEffect(context.project, context.cwd, context.scope));
    case AnalyzerName.Types:
      return internalEffect(name, context.project === undefined || !isTypeProject(context.project)
        ? Effect.fail(new Error("Type analyzer requires a TypeScript type project"))
        : similarTypesEffect(context.project, context.cwd, context.scope, context.typeSimilarityThreshold));
    case AnalyzerName.AsyncRisk:
      return internalEffect(name, context.project === undefined
        ? Effect.fail(new Error("Async-risk analyzer requires a syntax project"))
        : asyncRisksEffect(context.project, context.cwd, context.scope));
    case AnalyzerName.Dependencies:
      return dependencyAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs, { process: context.processRunner });
    case AnalyzerName.Knip:
      return knipAnalyzerEffect(context.cwd, context.maxMemoryMb, context.externalTimeoutMs, { process: context.processRunner });
    case AnalyzerName.Eslint:
      return eslintAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs, { process: context.processRunner });
    case AnalyzerName.Bundle:
      return bundleAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs, { beforeEntry: context.beforeBundleEntry, process: context.processRunner });
  }
}
