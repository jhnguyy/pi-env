import { Effect } from "effect";
import { asyncRisksEffect, complexityEffect, duplicatesEffect, similarTypesEffect, testDuplicatesEffect } from "./analyzers.js";
import { bundleAnalyzerEffect, dependencyAnalyzerEffect, eslintAnalyzerEffect, knipAnalyzerEffect } from "./external.js";
import { AnalyzerName, AnalyzerRunError, type Finding } from "./model.js";
import { SyntaxSourceSelection, type SyntaxProject, type TypeProject } from "./program.js";
import type { ProcessService } from "./process.js";
import type { Scope } from "./scope.js";

export interface SyntaxAnalyzerContext {
  cwd: string;
  scope: Scope;
  project: SyntaxProject;
}

export interface TypeAnalyzerContext {
  cwd: string;
  scope: Scope;
  project: TypeProject;
  typeSimilarityThreshold?: number;
}

export interface ExternalAnalyzerContext {
  cwd: string;
  scope: Scope;
  maxMemoryMb: number;
  externalTimeoutMs?: number;
  beforeBundleEntry: (entrypoint: string) => boolean;
}

interface AnalyzerDescriptorBase {
  name: AnalyzerName;
  defaultEnabled: boolean;
  /** Minimum total analysis budget, based on conservative observed peak runs. */
  minimumTotalMemoryMb: number;
}

export interface SyntaxAnalyzerDescriptor extends AnalyzerDescriptorBase {
  capability: "syntax";
  sourceSelection: SyntaxSourceSelection;
  run: (context: SyntaxAnalyzerContext) => Effect.Effect<Finding[], AnalyzerRunError>;
}

export interface TypeAnalyzerDescriptor extends AnalyzerDescriptorBase {
  capability: "type";
  run: (context: TypeAnalyzerContext) => Effect.Effect<Finding[], AnalyzerRunError>;
}

export interface ExternalAnalyzerDescriptor extends AnalyzerDescriptorBase {
  capability: "external";
  run: (context: ExternalAnalyzerContext) => Effect.Effect<Finding[], AnalyzerRunError, ProcessService>;
}

export type AnalyzerDescriptor =
  | SyntaxAnalyzerDescriptor
  | TypeAnalyzerDescriptor
  | ExternalAnalyzerDescriptor;

const analyzerError = (analyzer: AnalyzerName, cause: unknown): AnalyzerRunError =>
  cause instanceof AnalyzerRunError
    ? cause
    : new AnalyzerRunError({ analyzer, message: cause instanceof Error ? cause.message : String(cause) });

const internalEffect = (name: AnalyzerName, operation: Effect.Effect<Finding[], unknown>): Effect.Effect<Finding[], AnalyzerRunError> =>
  operation.pipe(Effect.mapError((cause) => analyzerError(name, cause)));

const ANALYZERS = {
  [AnalyzerName.Complexity]: {
    name: AnalyzerName.Complexity,
    defaultEnabled: true,
    minimumTotalMemoryMb: 512,
    capability: "syntax",
    sourceSelection: SyntaxSourceSelection.Production,
    run: (context) => internalEffect(AnalyzerName.Complexity, complexityEffect(context.project, context.cwd, context.scope)),
  },
  [AnalyzerName.Duplicates]: {
    name: AnalyzerName.Duplicates,
    defaultEnabled: true,
    minimumTotalMemoryMb: 512,
    capability: "syntax",
    sourceSelection: SyntaxSourceSelection.Production,
    run: (context) => internalEffect(AnalyzerName.Duplicates, duplicatesEffect(context.project, context.cwd, context.scope)),
  },
  [AnalyzerName.TestDuplicates]: {
    name: AnalyzerName.TestDuplicates,
    defaultEnabled: false,
    minimumTotalMemoryMb: 512,
    capability: "syntax",
    sourceSelection: SyntaxSourceSelection.Tests,
    run: (context) => internalEffect(AnalyzerName.TestDuplicates, testDuplicatesEffect(context.project, context.cwd, context.scope)),
  },
  [AnalyzerName.Types]: {
    name: AnalyzerName.Types,
    defaultEnabled: true,
    minimumTotalMemoryMb: 1024,
    capability: "type",
    run: (context) => internalEffect(AnalyzerName.Types, similarTypesEffect(context.project, context.cwd, context.scope, context.typeSimilarityThreshold)),
  },
  [AnalyzerName.AsyncRisk]: {
    name: AnalyzerName.AsyncRisk,
    defaultEnabled: true,
    minimumTotalMemoryMb: 512,
    capability: "syntax",
    sourceSelection: SyntaxSourceSelection.Production,
    run: (context) => internalEffect(AnalyzerName.AsyncRisk, asyncRisksEffect(context.project, context.cwd, context.scope)),
  },
  [AnalyzerName.Eslint]: {
    name: AnalyzerName.Eslint,
    defaultEnabled: true,
    minimumTotalMemoryMb: 1536,
    capability: "external",
    run: (context) => eslintAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs),
  },
  [AnalyzerName.Dependencies]: {
    name: AnalyzerName.Dependencies,
    defaultEnabled: true,
    minimumTotalMemoryMb: 768,
    capability: "external",
    run: (context) => dependencyAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs),
  },
  [AnalyzerName.Knip]: {
    name: AnalyzerName.Knip,
    defaultEnabled: true,
    minimumTotalMemoryMb: 768,
    capability: "external",
    run: (context) => knipAnalyzerEffect(context.cwd, context.maxMemoryMb, context.externalTimeoutMs),
  },
  [AnalyzerName.Bundle]: {
    name: AnalyzerName.Bundle,
    defaultEnabled: false,
    minimumTotalMemoryMb: 768,
    capability: "external",
    run: (context) => bundleAnalyzerEffect(context.cwd, context.scope, context.maxMemoryMb, context.externalTimeoutMs, { beforeEntry: context.beforeBundleEntry }),
  },
} satisfies Readonly<Record<AnalyzerName, AnalyzerDescriptor>>;

const ANALYZER_ORDER: readonly AnalyzerName[] = [
  AnalyzerName.Complexity,
  AnalyzerName.Duplicates,
  AnalyzerName.TestDuplicates,
  AnalyzerName.Types,
  AnalyzerName.AsyncRisk,
  AnalyzerName.Eslint,
  AnalyzerName.Dependencies,
  AnalyzerName.Knip,
  AnalyzerName.Bundle,
];

export const defaultAnalyzerNames = ANALYZER_ORDER.filter((name) => ANALYZERS[name].defaultEnabled);

export const resolveAnalyzerDescriptors = (names: readonly AnalyzerName[]): readonly AnalyzerDescriptor[] =>
  names.map((name) => ANALYZERS[name]);
