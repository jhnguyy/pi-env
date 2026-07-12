import { Effect } from "effect";
import { asyncRisksEffect, complexityEffect, duplicatesEffect, similarTypesEffect } from "./analyzers.js";
import { bundleAnalyzerEffect, dependencyAnalyzerEffect, eslintAnalyzerEffect, knipAnalyzerEffect } from "./external.js";
import { AnalyzerName, AnalyzerRunError, type Finding } from "./model.js";
import { isTypeProject, ProjectRequirement, type Project } from "./program.js";
import { ProcessService } from "./process.js";
import type { Scope } from "./scope.js";

export interface AnalyzerContext {
  cwd: string;
  scope: Scope;
  project?: Project;
  typeSimilarityThreshold?: number;
  maxMemoryMb: number;
  externalTimeoutMs?: number;
  beforeBundleEntry: (entrypoint: string) => boolean;
}

type AnalyzerRunner = (context: AnalyzerContext) => Effect.Effect<Finding[], AnalyzerRunError, ProcessService>;

export interface AnalyzerDescriptor {
  name: AnalyzerName;
  defaultEnabled: boolean;
  /** Minimum total analysis budget, based on conservative observed peak runs. */
  minimumTotalMemoryMb: number;
  project: ProjectRequirement;
  run: AnalyzerRunner;
}

const analyzerError = (analyzer: AnalyzerName, cause: unknown): AnalyzerRunError =>
  cause instanceof AnalyzerRunError
    ? cause
    : new AnalyzerRunError({ analyzer, message: cause instanceof Error ? cause.message : String(cause) });

const internalEffect = (name: AnalyzerName, operation: Effect.Effect<Finding[], unknown>): Effect.Effect<Finding[], AnalyzerRunError> =>
  operation.pipe(Effect.mapError((cause) => analyzerError(name, cause)));

const missingProject = (analyzer: AnalyzerName, message: string): Effect.Effect<never, AnalyzerRunError> =>
  Effect.fail(new AnalyzerRunError({ analyzer, message }));

const ANALYZERS: readonly AnalyzerDescriptor[] = [
  {
    name: AnalyzerName.Complexity,
    defaultEnabled: true,
    minimumTotalMemoryMb: 512,
    project: ProjectRequirement.ScopedSyntax,
    run: (context) => internalEffect(AnalyzerName.Complexity, context.project === undefined
      ? missingProject(AnalyzerName.Complexity, "Complexity analyzer requires a syntax project")
      : complexityEffect(context.project, context.cwd, context.scope)),
  },
  {
    name: AnalyzerName.Duplicates,
    defaultEnabled: true,
    minimumTotalMemoryMb: 768,
    project: ProjectRequirement.CorpusSyntax,
    run: (context) => internalEffect(AnalyzerName.Duplicates, context.project === undefined
      ? missingProject(AnalyzerName.Duplicates, "Duplicate analyzer requires a syntax project")
      : duplicatesEffect(context.project, context.cwd, context.scope)),
  },
  {
    name: AnalyzerName.Types,
    defaultEnabled: true,
    minimumTotalMemoryMb: 1024,
    project: ProjectRequirement.Types,
    run: (context) => internalEffect(AnalyzerName.Types, context.project === undefined || !isTypeProject(context.project)
      ? missingProject(AnalyzerName.Types, "Type analyzer requires a TypeScript type project")
      : similarTypesEffect(context.project, context.cwd, context.scope, context.typeSimilarityThreshold)),
  },
  {
    name: AnalyzerName.AsyncRisk,
    defaultEnabled: true,
    minimumTotalMemoryMb: 512,
    project: ProjectRequirement.ScopedSyntax,
    run: (context) => internalEffect(AnalyzerName.AsyncRisk, context.project === undefined
      ? missingProject(AnalyzerName.AsyncRisk, "Async-risk analyzer requires a syntax project")
      : asyncRisksEffect(context.project, context.cwd, context.scope)),
  },
  {
    name: AnalyzerName.Eslint,
    defaultEnabled: true,
    minimumTotalMemoryMb: 1536,
    project: ProjectRequirement.None,
    run: (context) => eslintAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs),
  },
  {
    name: AnalyzerName.Dependencies,
    defaultEnabled: true,
    minimumTotalMemoryMb: 768,
    project: ProjectRequirement.None,
    run: (context) => dependencyAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs),
  },
  {
    name: AnalyzerName.Knip,
    defaultEnabled: true,
    minimumTotalMemoryMb: 768,
    project: ProjectRequirement.None,
    run: (context) => knipAnalyzerEffect(context.cwd, context.maxMemoryMb, context.externalTimeoutMs),
  },
  {
    name: AnalyzerName.Bundle,
    defaultEnabled: false,
    minimumTotalMemoryMb: 768,
    project: ProjectRequirement.None,
    run: (context) => bundleAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs, { beforeEntry: context.beforeBundleEntry }),
  },
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

export function runAnalyzer(name: AnalyzerName, context: AnalyzerContext): Effect.Effect<Finding[], AnalyzerRunError, ProcessService> {
  return analyzerDescriptor(name).run(context);
}
