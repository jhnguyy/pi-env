#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { gitFiles } from "./check-patterns.js";

export const EFFECT_V4_MIGRATION_BASELINE = Object.freeze({
  "Context.GenericTag": 1,
  "Context.Tag": 1,
  "Effect.async": 11,
  "Effect.catchAll": 8,
  "Effect.either": 47,
  "Effect Either reference": 55,
  "Schema.Literal variadic": 3,
  "Schema.Record object form": 3,
  "Schema.Schema namespace": 11,
  "Schema.Union variadic": 1,
  "Schema.decodeUnknown": 3,
  "Schema.int": 1,
  "Schema.positive": 1,
  "untracked Effect import shape": 0,
});

const MEMBER_RULES = new Map([
  ["Context.GenericTag", ["Context", "GenericTag"]],
  ["Context.Tag", ["Context", "Tag"]],
  ["Effect.async", ["Effect", "async"]],
  ["Effect.catchAll", ["Effect", "catchAll"]],
  ["Effect.either", ["Effect", "either"]],
  ["Schema.Schema namespace", ["Schema", "Schema"]],
  ["Schema.decodeUnknown", ["Schema", "decodeUnknown"]],
  ["Schema.int", ["Schema", "int"]],
  ["Schema.positive", ["Schema", "positive"]],
]);

const DIRECT_MODULE_RULES = new Map([
  ["effect/Context", new Set(["GenericTag", "Tag"])],
  ["effect/Effect", new Set(["async", "catchAll", "either"])],
  ["effect/Schema", new Set(["Schema", "decodeUnknown", "int", "positive"])],
]);

function emptyCounts() {
  return Object.fromEntries(Object.keys(EFFECT_V4_MIGRATION_BASELINE).map((rule) => [rule, 0]));
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return [node.expression.text, node.name.text];
  }
  if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
    return [node.left.text, node.right.text];
  }
  return undefined;
}

function importedModuleAliases(sourceFile) {
  const aliases = {
    Context: new Set(),
    Effect: new Set(),
    Either: new Set(),
    Schema: new Set(),
  };
  let directImports = 0;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;

    if (moduleName === "effect") {
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (Object.hasOwn(aliases, imported)) aliases[imported].add(specifier.name.text);
        }
      } else {
        directImports += 1;
      }
      continue;
    }

    const directModule = moduleName.split("/").at(-1);
    if (DIRECT_MODULE_RULES.has(moduleName) && clause.namedBindings) {
      if (
        ts.isNamespaceImport(clause.namedBindings) &&
        directModule !== undefined &&
        Object.hasOwn(aliases, directModule)
      ) {
        aliases[directModule].add(clause.namedBindings.name.text);
      } else if (ts.isNamedImports(clause.namedBindings)) {
        const guarded = DIRECT_MODULE_RULES.get(moduleName);
        for (const specifier of clause.namedBindings.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (guarded.has(imported)) directImports += 1;
        }
      }
    }
  }

  return { aliases, directImports };
}

function isModuleCall(node, aliases, moduleName, name) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    aliases[moduleName].has(node.expression.expression.text) &&
    node.expression.name.text === name
  );
}

export function countV3EffectUsage(file, text) {
  const counts = emptyCounts();
  const scriptKind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const { aliases, directImports } = importedModuleAliases(sourceFile);
  counts["untracked Effect import shape"] = directImports;

  function visit(node) {
    const member = memberName(node);
    if (member !== undefined) {
      for (const [rule, expected] of MEMBER_RULES) {
        if (aliases[expected[0]].has(member[0]) && member[1] === expected[1]) counts[rule] += 1;
      }
    }

    if (ts.isIdentifier(node) && aliases.Either.has(node.text)) {
      counts["Effect Either reference"] += 1;
    }
    if (isModuleCall(node, aliases, "Schema", "Literal") && node.arguments.length > 1)
      counts["Schema.Literal variadic"] += 1;
    if (isModuleCall(node, aliases, "Schema", "Union") && node.arguments.length > 1)
      counts["Schema.Union variadic"] += 1;
    if (
      isModuleCall(node, aliases, "Schema", "Record") &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      counts["Schema.Record object form"] += 1;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return counts;
}

export function collectV3EffectUsage(files = gitFiles()) {
  const counts = emptyCounts();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const fileCounts = countV3EffectUsage(file, readFileSync(file, "utf8"));
    for (const rule of Object.keys(counts)) counts[rule] += fileCounts[rule];
  }
  return counts;
}

export function compareV3EffectUsage(actual, baseline = EFFECT_V4_MIGRATION_BASELINE) {
  const findings = [];
  for (const [rule, expected] of Object.entries(baseline)) {
    const observed = actual[rule] ?? 0;
    if (observed > expected)
      findings.push(`${rule}: migration debt grew from ${expected} to ${observed}`);
    if (observed < expected)
      findings.push(`${rule}: baseline is stale (${expected}); lower it to ${observed}`);
  }
  return findings;
}

export function reportV3EffectUsage(findings) {
  if (findings.length === 0) return "Effect v4 migration baseline is unchanged.";
  return [
    "Effect v4 migration-readiness findings",
    ...findings.map((finding) => `- ${finding}`),
  ].join("\n");
}

export function main(args = process.argv.slice(2)) {
  const actual = collectV3EffectUsage();
  if (args.includes("--print-baseline")) {
    console.log(JSON.stringify(actual, null, 2));
    return 0;
  }
  const findings = compareV3EffectUsage(actual);
  console.log(reportV3EffectUsage(findings));
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
