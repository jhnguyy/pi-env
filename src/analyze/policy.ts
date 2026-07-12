import { isAbsolute } from "node:path";
import { AnalyzerName, ScopeMode, type ScopeMode as Scope } from "./model.js";

export const SAFE_CHECKS = [AnalyzerName.Complexity, AnalyzerName.AsyncRisk] as const;
export type SafeAnalyzerName = (typeof SAFE_CHECKS)[number];

export const ANALYZE_LIMITS = {
  maxMemoryMb: 512,
  timeoutMs: 30_000,
  terminationGraceMs: 1_000,
  stdoutBytes: 256 * 1024,
  stderrBytes: 32 * 1024,
  resultBytes: 48 * 1024,
  findings: 200,
  failures: 64,
  relatedLocations: 16,
  paths: 128,
  pathLength: 1_024,
  cwdLength: 4_096,
  refLength: 512,
  messageLength: 2_048,
} as const;

export interface PublicAnalyzeRequest {
  readonly cwd: string;
  readonly scope?: Scope;
  readonly paths?: readonly string[];
  readonly ref?: string;
  readonly checks?: readonly string[];
  readonly maxMemoryMb?: number;
  readonly timeoutMs?: number;
  readonly profile?: boolean;
  readonly bundle?: boolean;
  readonly benchmarks?: readonly unknown[];
  readonly typeSimilarityThreshold?: number;
}

export interface SafeAnalyzeRequest {
  readonly cwd: string;
  readonly scope: typeof ScopeMode.Diff | typeof ScopeMode.Paths;
  readonly paths?: readonly string[];
  readonly ref?: string;
  readonly checks: readonly SafeAnalyzerName[];
  readonly maxMemoryMb: typeof ANALYZE_LIMITS.maxMemoryMb;
  readonly timeoutMs: number;
}

export type AnalyzePolicy =
  | { readonly _tag: "safe"; readonly request: SafeAnalyzeRequest }
  | { readonly _tag: "strict"; readonly reason: string }
  | { readonly _tag: "invalid"; readonly reason: string };

type RejectedPolicy = Exclude<AnalyzePolicy, { readonly _tag: "safe" }>;

const invalid = (reason: string): RejectedPolicy => ({ _tag: "invalid", reason });
const strict = (reason: string): RejectedPolicy => ({ _tag: "strict", reason });

export function isBoundedWorkspaceRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= ANALYZE_LIMITS.pathLength &&
    !isAbsolute(path) &&
    !path.includes("\0") &&
    !path.split(/[\\/]/).includes("..")
  );
}

function validateScalarInputs(input: PublicAnalyzeRequest): RejectedPolicy | undefined {
  if (
    typeof input.cwd !== "string" ||
    input.cwd.length === 0 ||
    input.cwd.length > ANALYZE_LIMITS.cwdLength ||
    !isAbsolute(input.cwd)
  ) {
    return invalid("cwd must be a bounded absolute path");
  }
  if (
    input.maxMemoryMb !== undefined &&
    (!Number.isInteger(input.maxMemoryMb) || input.maxMemoryMb < 1)
  ) {
    return invalid("maxMemoryMb must be a positive integer");
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)
  ) {
    return invalid("timeoutMs must be a positive integer");
  }
  return undefined;
}

function validateTypeThreshold(input: PublicAnalyzeRequest): RejectedPolicy | undefined {
  const threshold = input.typeSimilarityThreshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    return invalid("typeSimilarityThreshold must be between 0 and 1");
  }
  return undefined;
}

function classifyCapabilities(input: PublicAnalyzeRequest): RejectedPolicy | undefined {
  if (input.profile) return strict("profiling requires strict containment");
  if (input.typeSimilarityThreshold !== undefined) {
    return strict("type similarity requires strict containment");
  }
  if (input.bundle || (input.benchmarks?.length ?? 0) > 0) {
    return strict("bundle and benchmark analysis require strict containment");
  }
  if (input.scope === ScopeMode.All) return strict("all scope requires strict containment");
  return undefined;
}

function validateScopeAndPaths(
  scope: Scope,
  paths: readonly string[] | undefined,
): RejectedPolicy | undefined {
  if (scope !== ScopeMode.Diff && scope !== ScopeMode.Paths) {
    return invalid("unknown analysis scope");
  }
  if (scope === ScopeMode.Paths && (!paths || paths.length === 0)) {
    return invalid("paths scope requires non-empty explicit paths");
  }
  if (scope === ScopeMode.Diff && paths !== undefined && paths.length > 0) {
    return invalid("paths may only be supplied with paths scope");
  }
  if (
    paths &&
    (paths.length > ANALYZE_LIMITS.paths ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => typeof path !== "string" || !isBoundedWorkspaceRelativePath(path)))
  ) {
    return invalid("paths exceed safe request bounds");
  }
  return undefined;
}

function validateChecks(checks: readonly string[] | undefined): RejectedPolicy | undefined {
  if (!checks || checks.length === 0) {
    return invalid("checks must explicitly select complexity and/or async-risk");
  }
  if (new Set(checks).size !== checks.length) return invalid("checks must be unique");
  if (checks.some((check) => !SAFE_CHECKS.includes(check as SafeAnalyzerName))) {
    return strict("requested checks require strict containment");
  }
  return undefined;
}

function validateRef(ref: string | undefined): RejectedPolicy | undefined {
  if (
    ref !== undefined &&
    (typeof ref !== "string" ||
      ref.length === 0 ||
      ref.length > ANALYZE_LIMITS.refLength ||
      ref.startsWith("-") ||
      ref.includes("\0"))
  ) {
    return invalid("ref exceeds safe request bounds");
  }
  return undefined;
}

export function classifyAnalyzeRequest(input: PublicAnalyzeRequest): AnalyzePolicy {
  const scope = input.scope ?? ScopeMode.Diff;
  const rejection =
    validateScalarInputs(input) ??
    validateTypeThreshold(input) ??
    classifyCapabilities(input) ??
    validateScopeAndPaths(scope, input.paths) ??
    validateChecks(input.checks) ??
    validateRef(input.ref);
  if (rejection !== undefined) return rejection;

  return {
    _tag: "safe",
    request: {
      cwd: input.cwd,
      scope: scope as typeof ScopeMode.Diff | typeof ScopeMode.Paths,
      paths: input.paths,
      ref: input.ref,
      checks: input.checks as readonly SafeAnalyzerName[],
      maxMemoryMb: ANALYZE_LIMITS.maxMemoryMb,
      timeoutMs: Math.min(
        ANALYZE_LIMITS.timeoutMs,
        Math.max(1_000, input.timeoutMs ?? ANALYZE_LIMITS.timeoutMs),
      ),
    },
  };
}
