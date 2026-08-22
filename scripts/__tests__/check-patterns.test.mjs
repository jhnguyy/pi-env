import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeFile,
  analyzeText,
  GUARDED_EFFECT_COMBINATORS,
  TERMINAL_EFFECT_OPERATIONS,
} from "../check-patterns.js";

const CHECKER_PATH = fileURLToPath(new URL("../check-patterns.js", import.meta.url));
const NODE_RUNNER_PATH = fileURLToPath(new URL("../node-run.sh", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("check-patterns", () => {
  it("rejects committed catching tests without rejecting ordinary hardening tests", () => {
    expect(analyzeFile("src/example.catching.test.ts", "it('catches', () => {});")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Catching tests are ephemeral") }),
    ]);
    expect(analyzeFile("src/example.test.ts", "it('hardens', () => {});")).toEqual([]);
  });

  it("fails the CLI when a catching test is tracked", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-env-check-catching-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "tests"));
    writeFileSync(
      join(directory, "tests", "example.catching.test.ts"),
      "it('temporary', () => {});",
    );
    expect(spawnSync("git", ["init", "-q"], { cwd: directory }).status).toBe(0);
    expect(
      spawnSync("git", ["add", "tests/example.catching.test.ts"], { cwd: directory }).status,
    ).toBe(0);

    const result = spawnSync(NODE_RUNNER_PATH, [CHECKER_PATH], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Committed catching test found");
  });

  it("preserves the local formatError rule", () => {
    expect(
      analyzeText("scripts/example.ts", "function formatError(error) { return String(error); }"),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Local formatError helper found"),
      }),
    ]);
    expect(
      analyzeText(
        ".pi/extensions/_shared/errors.ts",
        "function formatError(error) { return String(error); }",
      ),
    ).toEqual([]);
    expect(
      analyzeText(
        "scripts/example.ts",
        `
      // function formatError(error) {}
      const example = "function formatError(error) {}";
    `,
      ),
    ).toEqual([]);
  });

  it("rejects actual flow composition calls without matching comments, strings, or unrelated property calls", () => {
    const findings = analyzeText(
      "src/example.ts",
      `
      // flow(Effect.map(fn))
      const text = "flow(Effect.map(fn))";
      thing.flow(Effect.map(fn));
      const composed = flow(Effect.map(fn));
    `,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5, message: expect.stringContaining("flow(...)") });
  });

  it("rejects bare references to the guarded overloaded Effect combinators", () => {
    const source = GUARDED_EFFECT_COMBINATORS.map(
      (name) => `const ${name}Ref = Effect.${name};`,
    ).join("\n");

    const findings = analyzeText("src/example.ts", source);

    expect(findings.map((finding) => finding.message)).toEqual(
      GUARDED_EFFECT_COMBINATORS.map(
        (name) =>
          `Bare Effect.${name} reference is not allowed. Call the combinator explicitly at the composition site.`,
      ),
    );
  });

  it("allows explicit Effect compositions and value constants", () => {
    const findings = analyzeText(
      "src/example.ts",
      `
      const a = pipe(value, Effect.map(fn));
      const b = value.pipe(Effect.map(fn));
      const c = Effect.void;
      const d = Effect.succeed(1);
    `,
    );

    expect(findings).toEqual([]);
  });

  it("requires namespace imports for local module APIs in migrated roots", () => {
    expect(
      analyzeText(
        "src/dag/example.ts",
        `
        import { run } from "./runtime.js";
        import type { DagNode } from "./contracts.js";
      `,
      ).map((finding) => finding.message),
    ).toEqual([
      expect.stringContaining("Use a namespace import"),
      expect.stringContaining("Use a namespace import"),
    ]);
  });

  it("allows namespace, public-barrel, package, default, and side-effect imports", () => {
    expect(
      analyzeText(
        "src/dag/example.ts",
        `
        import * as Runtime from "./runtime.js";
        import type * as Contracts from "./contracts.js";
        import { submitDagRun } from "./index.js";
        import { Effect } from "effect";
        import extension from "./extension.js";
        import "./register.js";
      `,
      ),
    ).toEqual([]);
    expect(analyzeText("src/analyze/example.ts", 'import { run } from "./runtime.js";')).toEqual(
      [],
    );
  });

  it("rejects JavaScript try/catch inside Effect.gen", () => {
    const findings = analyzeText(
      "src/example.ts",
      `
      const program = Effect.gen(function* () {
        try {
          yield* operation;
        } catch (error) {
          return yield* Effect.fail(error);
        }
      });
    `,
    );

    expect(findings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("try/catch is not allowed inside Effect.gen"),
      }),
    ]);
  });

  it("allows Effect failure handling and JavaScript try/catch outside Effect.gen", () => {
    const findings = analyzeText(
      "src/example.ts",
      `
      const program = Effect.gen(function* () {
        yield* Effect.sync(() => {
          try {
            compatibilityOperation();
          } catch (error) {
            reportCompatibilityFailure(error);
          }
        });
        return yield* Effect.try({ try: operation, catch: toFailure });
      });
      try {
        compatibilityOperation();
      } catch (error) {
        reportCompatibilityFailure(error);
      }
    `,
    );

    expect(findings).toEqual([]);
  });

  it("requires return yield* for terminal effects inside Effect.gen", () => {
    const source = TERMINAL_EFFECT_OPERATIONS.map((name) => {
      const effect = name === "interrupt" ? "Effect.interrupt" : `Effect.${name}(failure)`;
      return `const ${name}Program = Effect.gen(function* () { yield* ${effect}; });`;
    }).join("\n");

    const findings = analyzeText("src/example.ts", source);

    expect(findings.map((finding) => finding.message)).toEqual(
      TERMINAL_EFFECT_OPERATIONS.map(
        (name) => `Terminal Effect.${name} in Effect.gen must use return yield*.`,
      ),
    );
  });

  it("allows return yield* terminal effects and terminal effects outside Effect.gen", () => {
    const findings = analyzeText(
      "src/example.ts",
      `
      const failed = Effect.gen(function* () {
        return yield* Effect.fail(failure);
      });
      const interrupted = Effect.gen(function* () {
        const nestedGenerator = function* () {
          yield* Effect.fail(failure);
        };
        yield* Effect.succeed(nestedGenerator);
        return yield* Effect.interrupt;
      });
      function* compatibilityGenerator() {
        yield* Effect.fail(failure);
      }
    `,
    );

    expect(findings).toEqual([]);
  });

  it("exits nonzero from the CLI entrypoint when guardrail findings exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-env-check-patterns-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "example.ts"), "const f = flow(Effect.map(fn));");
    expect(spawnSync("git", ["init", "-q"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["add", "src/example.ts"], { cwd: directory }).status).toBe(0);

    const result = spawnSync(NODE_RUNNER_PATH, [CHECKER_PATH], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Pattern-fragmentation findings (1)");
  });
});
