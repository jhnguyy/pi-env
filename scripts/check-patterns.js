#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = process.cwd();
const SOURCE_ROOTS = [".pi/extensions", "src", "scripts", "setup", ".agents"];
export const GUARDED_EFFECT_COMBINATORS = ["andThen", "catch", "flatMap", "map", "match", "tap"];
const GUARDED_EFFECT_COMBINATOR_SET = new Set(GUARDED_EFFECT_COMBINATORS);

function trackedFiles(pathspecs = []) {
  const result = spawnSync("git", ["ls-files", ...pathspecs], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\n").filter(Boolean);
}

export function gitFiles() {
  return trackedFiles(SOURCE_ROOTS)
    .filter((file) => /\.(ts|js|mjs)$/.test(file))
    .filter((file) => !file.includes("/dist/"));
}

export function gitCatchingTests() {
  return trackedFiles().filter((file) => file.endsWith(".catching.test.ts"));
}

function location(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function isCallee(node) {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function isEffectPropertyAccess(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Effect"
  );
}

export function analyzeText(file, text) {
  const findings = [];
  const scriptKind = file.endsWith(".ts")
    ? ts.ScriptKind.TS
    : file.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);

  function visit(node) {
    if (
      file !== ".pi/extensions/_shared/errors.ts" &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "formatError"
    ) {
      findings.push({
        file,
        ...location(sourceFile, node.name),
        message:
          "Local formatError helper found. Prefer .pi/extensions/_shared/errors.ts unless this is intentionally domain-specific.",
      });
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "flow"
    ) {
      findings.push({
        file,
        ...location(sourceFile, node.expression),
        message:
          "flow(...) composition is not allowed. Prefer explicit pipe(...) or value.pipe(...) composition.",
      });
    }

    if (
      isEffectPropertyAccess(node) &&
      GUARDED_EFFECT_COMBINATOR_SET.has(node.name.text) &&
      !isCallee(node)
    ) {
      findings.push({
        file,
        ...location(sourceFile, node),
        message: `Bare Effect.${node.name.text} reference is not allowed. Call the combinator explicitly at the composition site.`,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export function analyzeFile(file, text) {
  const findings = analyzeText(file, text);
  if (file.endsWith(".catching.test.ts")) {
    findings.unshift({
      file,
      message:
        "Committed catching test found. Catching tests are ephemeral; independently derive any permanent hardening test.",
    });
  }
  return findings;
}

export function findPatternFindings(files = gitFiles(), catchingTests = gitCatchingTests()) {
  const findings = [];
  const scannedFiles = new Set(files);
  for (const file of files) {
    if (!existsSync(file)) continue;
    findings.push(...analyzeFile(file, readFileSync(file, "utf8")));
  }
  for (const file of catchingTests) {
    if (scannedFiles.has(file)) continue;
    findings.push(...analyzeFile(file, ""));
  }
  return findings;
}

export function reportFindings(findings, root = ROOT) {
  if (findings.length === 0) return "No pattern-fragmentation findings.";
  return [
    `Pattern-fragmentation findings (${findings.length})`,
    ...findings.map((finding) => {
      const where = finding.line ? `:${finding.line}:${finding.column}` : "";
      return `${relative(root, finding.file)}${where}: ${finding.message}`;
    }),
  ].join("\n");
}

export function main() {
  const findings = findPatternFindings();
  console.log(reportFindings(findings));
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
