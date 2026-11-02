import { join, resolve } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { duplicatesEffect } from "../../analyzers.js";
import type { Scope } from "../../scope.js";

const cwd = resolve("stack-depth-fixture");
// Left-associative addition parses without recursive expression nesting, but
// produces a deep AST. Keep the input fixed; constrain the stack, not host load.
const expression = Array.from({ length: 512 }, () => "value").join(" + ");
const source = ts.createSourceFile(
  join(cwd, "sample.ts"),
  `function alpha(value: number) { return ${expression}; }\nfunction beta(value: number) { return ${expression}; }\n`,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const scope: Scope = { mode: "all", files: [], hunks: new Map() };
const findings = await Effect.runPromise(
  duplicatesEffect({ files: [source], testFiles: [] }, cwd, scope),
);
console.log(JSON.stringify(findings));
