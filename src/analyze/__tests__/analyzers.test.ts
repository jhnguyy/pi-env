import { join, resolve } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { duplicatesEffect, testDuplicatesEffect } from "../analyzers.js";
import type { Scope } from "../scope.js";

const cwd = resolve("analyzer-fixture");
const allScope: Scope = { mode: "all", files: [], hunks: new Map() };
const sourceFile = (text: string) =>
  ts.createSourceFile(join(cwd, "sample.ts"), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

describe("duplicate analyzer behavior", () => {
  it.effect("retains collected duplicates when the candidate limit truncates scanning", () =>
    Effect.gen(function* () {
      const body =
        "const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; }";
      const source = sourceFile(
        [
          `function unique(input: number) { ${body} return { total }; }`,
          `function alpha(input: number) { ${body} return total; }`,
          `function beta(input: number) { ${body} return total; }`,
          ...Array.from({ length: 9_998 }, (_, index) => `function filler${index}() {}`),
        ].join("\n"),
      );
      const findings = yield* duplicatesEffect({ files: [source], testFiles: [] }, cwd, allScope);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            location: expect.objectContaining({ line: 2 }),
            related: [expect.objectContaining({ line: 3 })],
          }),
          expect.objectContaining({ data: { truncated: true } }),
        ]),
      );
    }),
  );

  it.effect("normalizes names and literals but distinguishes a different return shape", () =>
    Effect.gen(function* () {
      const source = sourceFile(`
        function alpha(input: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; } return total; }
        function beta(other: number) { const entries = [5,6,7,8]; let sum = 9; for (const entry of entries) { if (entry > other) sum += entry * 3; else sum += entry; } return sum; }
        function different(input: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; } return { total }; }
      `);

      const findings = yield* duplicatesEffect({ files: [source], testFiles: [] }, cwd, allScope);

      expect(findings).toHaveLength(1);
      expect(findings[0].location).toMatchObject({ path: "sample.ts", line: 2 });
      expect(findings[0].related).toEqual([
        expect.objectContaining({ path: "sample.ts", line: 3 }),
      ]);
    }),
  );

  it.effect(
    "matches normalized callback bodies in nested groups without including setup callbacks",
    () =>
      Effect.gen(function* () {
        const source = sourceFile(`
        describe("outer", () => {
          beforeEach(() => { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > 2) total += value * 2; else total += value; } expect(total).toBeGreaterThan(0); });
          it("first", () => { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > 2) total += value * 2; else total += value; } expect(total).toBeGreaterThan(0); });
          describe("inner", () => {
            test("second", () => { const entries = [5,6,7,8]; let sum = 9; for (const entry of entries) { if (entry > 3) sum += entry * 3; else sum += entry; } expect(sum).toBeGreaterThan(10); });
          });
        });
      `);

        const findings = yield* testDuplicatesEffect(
          { files: [], testFiles: [source] },
          cwd,
          allScope,
        );

        expect(findings).toHaveLength(1);
        expect(findings[0].location).toMatchObject({ path: "sample.ts", line: 4 });
        expect(findings[0].related).toEqual([
          expect.objectContaining({ path: "sample.ts", line: 6 }),
        ]);
      }),
  );
});
