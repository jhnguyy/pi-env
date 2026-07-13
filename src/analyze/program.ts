import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Effect } from "effect";
import ts from "typescript";
import { ProgramError, ScopeMode } from "./model.js";
import type { Scope } from "./scope.js";

export const ProjectRequirement = {
  None: "none",
  ScopedSyntax: "scoped-syntax",
  CorpusSyntax: "corpus-syntax",
  Types: "types",
} as const;
export type ProjectRequirement = typeof ProjectRequirement[keyof typeof ProjectRequirement];

export interface SyntaxProject { files: readonly ts.SourceFile[] }
export interface TypeProject extends SyntaxProject { program: ts.Program; checker: ts.TypeChecker }
export type Project = SyntaxProject | TypeProject;

export interface SyntaxSourceBudget {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

interface ParsedConfig {
  fileNames: readonly string[];
  options: ts.CompilerOptions;
}

const slash = (value: string): string => value.replaceAll("\\", "/");
const sourcePath = (cwd: string, fileName: string): string => slash(relative(cwd, resolve(fileName)));
const analyzableSource = (cwd: string, fileName: string): boolean => {
  const path = sourcePath(cwd, fileName);
  return !path.includes("node_modules/")
    && !/(^|\/)(dist|generated|__tests__)(\/|$)|\.test\.[cm]?[jt]sx?$/.test(path);
};

const toProgramError = (cause: unknown): ProgramError => cause instanceof ProgramError
  ? cause
  : new ProgramError({ message: cause instanceof Error ? cause.message : String(cause) });

/** Parses the project's tsconfig at the typed filesystem/compiler boundary. */
const parseTsconfigEffect = (cwd: string): Effect.Effect<ParsedConfig, ProgramError> => Effect.try({
  try: () => {
    const configPath = ts.findConfigFile(cwd, existsSync, "tsconfig.json");
    if (!configPath) throw new ProgramError({ message: "tsconfig.json not found" });
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new ProgramError({ message: ts.flattenDiagnosticMessageText(config.error.messageText, "\n") });
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
    if (parsed.errors.length > 0) {
      throw new ProgramError({ message: parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n") });
    }
    return { fileNames: parsed.fileNames, options: parsed.options };
  },
  catch: toProgramError,
});

export const tsconfigFileNamesEffect = (cwd: string): Effect.Effect<readonly string[], ProgramError> =>
  parseTsconfigEffect(cwd).pipe(Effect.map((parsed) => parsed.fileNames));

function sortedSourceFiles(cwd: string, files: readonly ts.SourceFile[]): readonly ts.SourceFile[] {
  return files
    .filter((file) => !file.isDeclarationFile && analyzableSource(cwd, file.fileName))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.json$/i.test(fileName)) return ts.ScriptKind.JSON;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function readBoundedSource(fileName: string, displayName: string, maxBytes: number): { text: string; bytes: number } {
  const fd = openSync(fileName, "r");
  try {
    const initialSize = fstatSync(fd).size;
    if (initialSize > maxBytes) {
      throw new ProgramError({ message: `Syntax source file byte limit exceeded: ${displayName}` });
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      bytes += read;
    }
    if (bytes > maxBytes) {
      throw new ProgramError({ message: `Syntax source file byte limit exceeded: ${displayName}` });
    }
    return { text: Buffer.concat(chunks, bytes).toString("utf8"), bytes };
  } finally {
    closeSync(fd);
  }
}

function createSyntaxProjectFromFiles(
  cwd: string,
  fileNames: readonly string[],
  target: ts.ScriptTarget,
  budget?: SyntaxSourceBudget,
): SyntaxProject {
  const analyzableFileNames = fileNames.filter((fileName) => analyzableSource(cwd, fileName));
  if (budget !== undefined && analyzableFileNames.length > budget.maxFiles) {
    throw new ProgramError({ message: `Syntax source file limit exceeded: ${analyzableFileNames.length} > ${budget.maxFiles}` });
  }
  const files: ts.SourceFile[] = [];
  let totalBytes = 0;
  for (const fileName of analyzableFileNames) {
    const source = budget === undefined
      ? { text: ts.sys.readFile(fileName), bytes: 0 }
      : readBoundedSource(fileName, sourcePath(cwd, fileName), budget.maxFileBytes);
    if (source.text === undefined) continue;
    totalBytes += source.bytes;
    if (budget !== undefined && totalBytes > budget.maxTotalBytes) {
      throw new ProgramError({ message: `Syntax source aggregate byte limit exceeded: ${totalBytes} > ${budget.maxTotalBytes}` });
    }
    files.push(ts.createSourceFile(fileName, source.text, target, true, scriptKind(fileName)));
  }
  return { files: files.sort((left, right) => left.fileName.localeCompare(right.fileName)) };
}

function createSyntaxProject(cwd: string, scope: Scope, scoped: boolean, parsed: ParsedConfig, budget?: SyntaxSourceBudget): SyntaxProject {
  const selected = scoped && scope.mode !== "all" ? new Set(scope.files) : undefined;
  const fileNames = selected === undefined
    ? parsed.fileNames
    : parsed.fileNames.filter((fileName) => selected.has(sourcePath(cwd, fileName)));
  return createSyntaxProjectFromFiles(cwd, fileNames, parsed.options.target ?? ts.ScriptTarget.Latest, budget);
}

function createExplicitSyntaxProject(cwd: string, scope: Scope, budget?: SyntaxSourceBudget): SyntaxProject {
  const root = realpathSync(cwd);
  const fileNames = scope.files.map((file) => {
    const resolved = realpathSync(resolve(root, file));
    const relativePath = sourcePath(root, resolved);
    if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("/")) {
      throw new ProgramError({ message: `Syntax source resolves outside cwd: ${file}` });
    }
    return resolved;
  });
  return createSyntaxProjectFromFiles(root, fileNames, ts.ScriptTarget.Latest, budget);
}

const createTypeProject = (cwd: string, parsed: ParsedConfig): TypeProject => {
  const program = ts.createProgram([...parsed.fileNames], parsed.options);
  return { program, checker: program.getTypeChecker(), files: sortedSourceFiles(cwd, program.getSourceFiles()) };
};

export const createProjectEffect = (cwd: string): Effect.Effect<TypeProject, ProgramError> =>
  Effect.flatMap(parseTsconfigEffect(cwd), (parsed) => Effect.try({
    try: () => createTypeProject(cwd, parsed),
    catch: toProgramError,
  }));

/** Loads only the project capability required by the selected analyzers. */
export const createAnalysisProjectEffect = (
  cwd: string,
  scope: Scope,
  requirement: ProjectRequirement,
  sourceBudget?: SyntaxSourceBudget,
): Effect.Effect<Project | undefined, ProgramError> => requirement === ProjectRequirement.None
  ? Effect.as(Effect.void, undefined as Project | undefined)
  : requirement === ProjectRequirement.ScopedSyntax && scope.mode !== ScopeMode.All
    ? Effect.try({ try: () => createExplicitSyntaxProject(cwd, scope, sourceBudget), catch: toProgramError })
    : Effect.flatMap(parseTsconfigEffect(cwd), (parsed) => Effect.try({
      try: () => {
        switch (requirement) {
          case ProjectRequirement.ScopedSyntax: return createSyntaxProject(cwd, scope, true, parsed, sourceBudget);
          case ProjectRequirement.CorpusSyntax: return createSyntaxProject(cwd, scope, false, parsed, sourceBudget);
          case ProjectRequirement.Types: return createTypeProject(cwd, parsed);
        }
      },
      catch: toProgramError,
    }));

export function isTypeProject(project: Project): project is TypeProject {
  return "checker" in project;
}
