import ts from "typescript";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ProgramError } from "./model.js";

export interface Project { program: ts.Program; checker: ts.TypeChecker; files: readonly ts.SourceFile[] }
export function tsconfigFileNames(cwd: string): readonly string[] {
  const configPath = ts.findConfigFile(cwd, existsSync, "tsconfig.json");
  if (!configPath) throw new ProgramError({ message: "tsconfig.json not found" });
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new ProgramError({ message: ts.flattenDiagnosticMessageText(config.error.messageText, "\n") });
  return ts.parseJsonConfigFileContent(config.config, ts.sys, cwd).fileNames;
}
export function createProject(cwd: string): Project {
  const fileNames = tsconfigFileNames(cwd);
  const configPath = ts.findConfigFile(cwd, existsSync, "tsconfig.json")!;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
  const program = ts.createProgram(fileNames, parsed.options);
  const files = program.getSourceFiles().filter(f => {
    const path = relative(cwd, resolve(f.fileName)).replaceAll("\\", "/");
    return !f.isDeclarationFile && !path.includes("node_modules/") && !/(^|\/)(dist|generated|__tests__)(\/|$)|\.test\.[cm]?[jt]sx?$/.test(path);
  }).sort((a,b) => a.fileName.localeCompare(b.fileName));
  return { program, checker: program.getTypeChecker(), files };
}
