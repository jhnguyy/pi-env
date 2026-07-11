import { Data } from "effect";

export const Severity = { Info: "info", Warning: "warning", Error: "error" } as const;
export type Severity = typeof Severity[keyof typeof Severity];
export const FindingKind = { Complexity: "complexity", Duplicate: "duplicate", TypeSimilarity: "type-similarity", Lint: "lint", Dependency: "dependency", AlgorithmicRisk: "algorithmic-risk", AsyncRisk: "async-risk", Bundle: "bundle" } as const;
export type FindingKind = typeof FindingKind[keyof typeof FindingKind];
export const ScopeMode = { All: "all", Paths: "paths", Diff: "diff" } as const;
export type ScopeMode = typeof ScopeMode[keyof typeof ScopeMode];
export const OutputMode = { Compact: "compact", Pretty: "pretty", Json: "json" } as const;
export type OutputMode = typeof OutputMode[keyof typeof OutputMode];
export const FailPolicy = { Never: "never", Warning: "warning", Error: "error" } as const;
export type FailPolicy = typeof FailPolicy[keyof typeof FailPolicy];
export const AnalyzerName = { Complexity: "complexity", Duplicates: "duplicates", Types: "types", AsyncRisk: "async-risk", Eslint: "eslint", Dependencies: "dependencies", Knip: "knip", Bundle: "bundle" } as const;
export type AnalyzerName = typeof AnalyzerName[keyof typeof AnalyzerName];
export interface Location { path: string; line: number; column: number; endLine?: number; endColumn?: number }
export interface Finding { id: string; analyzer: AnalyzerName; kind: FindingKind; severity: Severity; message: string; location: Location; related?: readonly Location[]; data?: Readonly<Record<string, unknown>> }
export interface AnalyzerFailure { analyzer: AnalyzerName | "benchmark" | "configuration" | "scope" | "program"; message: string }
export interface BenchmarkResult { command: string; runs: readonly number[]; meanMs?: number; failure?: string }
export interface MemorySnapshot { rssBytes: number; heapUsedBytes: number; externalBytes: number }
interface AnalysisProfile { timings: Readonly<Record<string, number>>; memory: Readonly<Record<string, MemorySnapshot>>; peak: MemorySnapshot }
export interface AnalysisResult { version: 1; summary: { info: number; warning: number; error: number; failures: number }; findings: readonly Finding[]; analyzerFailures: readonly AnalyzerFailure[]; benchmarks: readonly BenchmarkResult[]; profile?: AnalysisProfile }
export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string }>{}
export class ScopeError extends Data.TaggedError("ScopeError")<{ message: string }>{}
export class ProgramError extends Data.TaggedError("ProgramError")<{ message: string }>{}
export class AnalyzerRunError extends Data.TaggedError("AnalyzerRunError")<{ analyzer: AnalyzerName; message: string }>{}
export class BenchmarkError extends Data.TaggedError("BenchmarkError")<{ message: string; runs?: readonly number[] }>{}
export const ProcessErrorKind = { Spawn: "spawn", Exit: "exit", Timeout: "timeout", OutputLimit: "output-limit", Interrupted: "interrupted" } as const;
export type ProcessErrorKind = typeof ProcessErrorKind[keyof typeof ProcessErrorKind];
export class ProcessError extends Data.TaggedError("ProcessError")<{
  kind: ProcessErrorKind;
  command: string;
  message: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}>{}
export type AnalyzeError = ConfigError | ScopeError | ProgramError;
