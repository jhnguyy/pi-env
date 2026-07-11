import { Effect } from "effect";
import { asyncRisks, complexity, duplicates, similarTypes } from "./analyzers.js";
import { bundleAnalyzer, dependencyAnalyzerEffect, eslintAnalyzerEffect, knipAnalyzerEffect } from "./external.js";
import { AnalyzerName, AnalyzerRunError, type Finding } from "./model.js";
import { isTypeProject, ProjectRequirement, type Project } from "./program.js";
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
}

const analyzerError = (analyzer: AnalyzerName, cause: unknown): AnalyzerRunError =>
  cause instanceof AnalyzerRunError
    ? cause
    : new AnalyzerRunError({ analyzer, message: cause instanceof Error ? cause.message : String(cause) });

function internalEffect(name: AnalyzerName, operation: () => Finding[]): Effect.Effect<Finding[], AnalyzerRunError> {
  return Effect.try({ try: operation, catch: (cause) => analyzerError(name, cause) });
}

export function runAnalyzer(name: AnalyzerName, context: AnalyzerContext): Effect.Effect<Finding[], AnalyzerRunError> {
  switch (name) {
    case AnalyzerName.Complexity:
      return internalEffect(name, () => complexity(context.project!, context.cwd, context.scope));
    case AnalyzerName.Duplicates:
      return internalEffect(name, () => duplicates(context.project!, context.cwd, context.scope));
    case AnalyzerName.Types:
      return internalEffect(name, () => {
        if (context.project === undefined || !isTypeProject(context.project)) throw new Error("Type analyzer requires a TypeScript type project");
        return similarTypes(context.project, context.cwd, context.scope, context.typeSimilarityThreshold);
      });
    case AnalyzerName.AsyncRisk:
      return internalEffect(name, () => asyncRisks(context.project!, context.cwd, context.scope));
    case AnalyzerName.Dependencies:
      return dependencyAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs);
    case AnalyzerName.Knip:
      return knipAnalyzerEffect(context.cwd, context.maxMemoryMb, context.externalTimeoutMs);
    case AnalyzerName.Eslint:
      return eslintAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs);
    case AnalyzerName.Bundle:
      return Effect.tryPromise({
        try: () => bundleAnalyzer(context.cwd, context.scope, { beforeEntry: context.beforeBundleEntry }),
        catch: (cause) => analyzerError(name, cause),
      });
  }
}
