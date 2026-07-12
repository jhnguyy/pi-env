import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Effect } from "effect";
import ts from "typescript";
import { ProgramError } from "./model.js";
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

function createSyntaxProject(cwd: string, scope: Scope, scoped: boolean, parsed: ParsedConfig): SyntaxProject {
  const selected = scoped && scope.mode !== "all" ? new Set(scope.files) : undefined;
  const files: ts.SourceFile[] = [];
  for (const fileName of parsed.fileNames) {
    if (!analyzableSource(cwd, fileName)) continue;
    if (selected !== undefined && !selected.has(sourcePath(cwd, fileName))) continue;
    const text = ts.sys.readFile(fileName);
    if (text === undefined) continue;
    files.push(ts.createSourceFile(
      fileName,
      text,
      parsed.options.target ?? ts.ScriptTarget.Latest,
      true,
      scriptKind(fileName),
    ));
  }
  return { files: files.sort((left, right) => left.fileName.localeCompare(right.fileName)) };
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
): Effect.Effect<Project | undefined, ProgramError> => requirement === ProjectRequirement.None
  ? Effect.succeed(undefined)
  : Effect.flatMap(parseTsconfigEffect(cwd), (parsed) => Effect.try({
    try: () => {
      switch (requirement) {
        case ProjectRequirement.ScopedSyntax: return createSyntaxProject(cwd, scope, true, parsed);
        case ProjectRequirement.CorpusSyntax: return createSyntaxProject(cwd, scope, false, parsed);
        case ProjectRequirement.Types: return createTypeProject(cwd, parsed);
      }
    },
    catch: toProgramError,
  }));

export function isTypeProject(project: Project): project is TypeProject {
  return "checker" in project;
}
