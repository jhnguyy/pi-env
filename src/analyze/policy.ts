import { isAbsolute } from "node:path";
import { Data } from "effect";
import {
  AnalyzerName,
  ScopeMode,
  type NonEmptyReadonlyArray,
  type ScopeMode as Scope,
  type ScopeSelection,
} from "./model.js";
import { isDriveQualifiedPath } from "./workspace-path.js";

export const SAFE_CHECKS = [
  AnalyzerName.Complexity,
  AnalyzerName.AsyncRisk,
  AnalyzerName.Duplicates,
  AnalyzerName.TestDuplicates,
] as const;
export type SafeAnalyzerName = (typeof SAFE_CHECKS)[number];
export type SafeScopeSelection = Exclude<ScopeSelection, { readonly scope: typeof ScopeMode.All }>;

export const ANALYZE_LIMITS = {
  maxMemoryMb: 512,
  timeoutMs: 30_000,
  terminationGraceMs: 1_000,
  stdoutBytes: 256 * 1024,
  stderrBytes: 32 * 1024,
  resultBytes: 48 * 1024,
  findings: 200,
  failures: 64,
  sourceFiles: 1_024,
  sourceFileBytes: 256 * 1024,
  sourceBytes: 2 * 1024 * 1024,
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

interface SafeAnalyzeRequestFields {
  readonly cwd: string;
  readonly checks: NonEmptyReadonlyArray<SafeAnalyzerName>;
  readonly maxMemoryMb: typeof ANALYZE_LIMITS.maxMemoryMb;
  readonly maxSourceFiles: typeof ANALYZE_LIMITS.sourceFiles;
  readonly maxSourceFileBytes: typeof ANALYZE_LIMITS.sourceFileBytes;
  readonly maxSourceBytes: typeof ANALYZE_LIMITS.sourceBytes;
  readonly timeoutMs: number;
}

export type SafeAnalyzeRequest = SafeAnalyzeRequestFields & SafeScopeSelection;

export type AnalyzePolicy = Data.TaggedEnum<{
  safe: { readonly request: SafeAnalyzeRequest };
  strict: { readonly reason: string };
  invalid: { readonly reason: string };
}>;
export const AnalyzePolicy = Data.taggedEnum<AnalyzePolicy>();

type RejectedPolicy = Exclude<AnalyzePolicy, { readonly _tag: "safe" }>;
const invalid = (reason: string): RejectedPolicy => AnalyzePolicy.invalid({ reason });
const strict = (reason: string): RejectedPolicy => AnalyzePolicy.strict({ reason });
const isRejected = (value: unknown): value is RejectedPolicy =>
  value !== null && typeof value === "object" && "_tag" in value;

export function isBoundedWorkspaceRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= ANALYZE_LIMITS.pathLength &&
    !isAbsolute(path) &&
    !isDriveQualifiedPath(path) &&
    !path.includes("\0") &&
    !path.split(/[\\/]/).includes("..")
  );
}

function parseDiffScope(
  paths: unknown,
  ref: unknown,
): Extract<ScopeSelection, { readonly scope: typeof ScopeMode.Diff }> | RejectedPolicy {
  if (paths !== undefined) return invalid("paths may only be supplied with paths scope");
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
  return { scope: ScopeMode.Diff, ...(ref === undefined ? {} : { ref }) };
}

function parsePathsScope(
  paths: unknown,
  ref: unknown,
): Extract<ScopeSelection, { readonly scope: typeof ScopeMode.Paths }> | RejectedPolicy {
  if (ref !== undefined) return invalid("ref may only be supplied with diff scope");
  if (!Array.isArray(paths) || paths.length === 0) {
    return invalid("paths scope requires non-empty explicit paths");
  }
  if (paths.length > ANALYZE_LIMITS.paths || new Set(paths).size !== paths.length) {
    return invalid("paths exceed safe request bounds");
  }
  const [first, ...rest] = paths;
  if (
    typeof first !== "string" ||
    !isBoundedWorkspaceRelativePath(first) ||
    rest.some((path) => typeof path !== "string" || !isBoundedWorkspaceRelativePath(path))
  ) {
    return invalid("paths exceed safe request bounds");
  }
  return { scope: ScopeMode.Paths, paths: [first, ...rest] };
}

function parseScopeSelection(input: PublicAnalyzeRequest): ScopeSelection | RejectedPolicy {
  switch (input.scope ?? ScopeMode.Diff) {
    case ScopeMode.All:
      return input.paths === undefined && input.ref === undefined
        ? { scope: ScopeMode.All }
        : invalid("all scope cannot include paths or ref");
    case ScopeMode.Diff:
      return parseDiffScope(input.paths, input.ref);
    case ScopeMode.Paths:
      return parsePathsScope(input.paths, input.ref);
    default:
      return invalid("unknown analysis scope");
  }
}

const analyzerNames: readonly string[] = Object.values(AnalyzerName);
export const isAnalyzerName = (value: unknown): value is AnalyzerName =>
  typeof value === "string" && analyzerNames.includes(value);
export const isSafeAnalyzerName = (value: unknown): value is SafeAnalyzerName =>
  typeof value === "string" && SAFE_CHECKS.some((check) => check === value);

function parseChecks(value: unknown): NonEmptyReadonlyArray<SafeAnalyzerName> | RejectedPolicy {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid(
      "checks must explicitly select complexity, async-risk, duplicates, and/or test-duplicates",
    );
  }
  if (value.length > analyzerNames.length) return invalid("too many analysis checks");
  if (new Set(value).size !== value.length) return invalid("checks must be unique");
  if (!value.every(isAnalyzerName)) return invalid("unknown analysis check");
  if (!value.every(isSafeAnalyzerName)) {
    return strict("requested checks require strict containment");
  }
  const [first, ...rest] = value;
  return first === undefined ? invalid("checks must not be empty") : [first, ...rest];
}

function parseCwd(value: unknown): { readonly cwd: string } | RejectedPolicy {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= ANALYZE_LIMITS.cwdLength &&
    isAbsolute(value)
    ? { cwd: value }
    : invalid("cwd must be a bounded absolute path");
}

function parseSafeLimits(input: PublicAnalyzeRequest): { readonly timeoutMs: number } | RejectedPolicy {
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
  return {
    timeoutMs: Math.min(
      ANALYZE_LIMITS.timeoutMs,
      Math.max(1_000, input.timeoutMs ?? ANALYZE_LIMITS.timeoutMs),
    ),
  };
}

type ParsedCapability = { readonly reason?: string } | RejectedPolicy;

function parseTypeSimilarityCapability(value: unknown): ParsedCapability {
  if (value === undefined) return {};
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? { reason: "type similarity requires strict containment" }
    : invalid("typeSimilarityThreshold must be between 0 and 1");
}

function parseFlagCapabilities(input: PublicAnalyzeRequest): ParsedCapability {
  if (input.profile !== undefined && typeof input.profile !== "boolean") {
    return invalid("profile must be a boolean");
  }
  if (input.bundle !== undefined && typeof input.bundle !== "boolean") {
    return invalid("bundle must be a boolean");
  }
  if (input.benchmarks !== undefined && !Array.isArray(input.benchmarks)) {
    return invalid("benchmarks must be an array");
  }
  if (input.profile) return { reason: "profiling requires strict containment" };
  return input.bundle || (input.benchmarks?.length ?? 0) > 0
    ? { reason: "bundle and benchmark analysis require strict containment" }
    : {};
}

function parseStrictCapabilities(input: PublicAnalyzeRequest): ParsedCapability {
  const typeSimilarity = parseTypeSimilarityCapability(input.typeSimilarityThreshold);
  if (isRejected(typeSimilarity)) return typeSimilarity;
  const flags = parseFlagCapabilities(input);
  if (isRejected(flags)) return flags;
  if (input.profile === true) return flags;
  return typeSimilarity.reason === undefined ? flags : typeSimilarity;
}

export function classifyAnalyzeRequest(input: PublicAnalyzeRequest): AnalyzePolicy {
  const cwd = parseCwd(input.cwd);
  if (isRejected(cwd)) return cwd;
  const limits = parseSafeLimits(input);
  if (isRejected(limits)) return limits;
  const capabilities = parseStrictCapabilities(input);
  if (isRejected(capabilities)) return capabilities;
  const scope = parseScopeSelection(input);
  if (isRejected(scope)) return scope;
  const checks = parseChecks(input.checks);
  if (isRejected(checks)) return checks;

  if (capabilities.reason !== undefined) return strict(capabilities.reason);
  if (scope.scope === ScopeMode.All) return strict("all scope requires strict containment");

  return AnalyzePolicy.safe({
    request: {
      cwd: cwd.cwd,
      ...scope,
      checks,
      maxMemoryMb: ANALYZE_LIMITS.maxMemoryMb,
      maxSourceFiles: ANALYZE_LIMITS.sourceFiles,
      maxSourceFileBytes: ANALYZE_LIMITS.sourceFileBytes,
      maxSourceBytes: ANALYZE_LIMITS.sourceBytes,
      timeoutMs: limits.timeoutMs,
    },
  });
}
