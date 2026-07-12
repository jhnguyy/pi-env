import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeText, GUARDED_EFFECT_COMBINATORS } from "../check-patterns.js";

const CHECKER_PATH = fileURLToPath(new URL("../check-patterns.js", import.meta.url));
const NODE_RUNNER_PATH = fileURLToPath(new URL("../node-run.sh", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("check-patterns", () => {
  it("preserves the local formatError rule", () => {
    expect(analyzeText("scripts/example.ts", "function formatError(error) { return String(error); }"))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("Local formatError helper found") })]);
    expect(analyzeText(".pi/extensions/_shared/errors.ts", "function formatError(error) { return String(error); }"))
      .toEqual([]);
  });

  it("rejects actual flow composition calls without matching comments, strings, or unrelated property calls", () => {
    const findings = analyzeText("src/example.ts", `
      // flow(Effect.map(fn))
      const text = "flow(Effect.map(fn))";
      thing.flow(Effect.map(fn));
      const composed = flow(Effect.map(fn));
    `);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5, message: expect.stringContaining("flow(...)") });
  });

  it("rejects bare references to the guarded overloaded Effect combinators", () => {
    const source = GUARDED_EFFECT_COMBINATORS
      .map((name) => `const ${name}Ref = Effect.${name};`)
      .join("\n");

    const findings = analyzeText("src/example.ts", source);

    expect(findings.map((finding) => finding.message)).toEqual(
      GUARDED_EFFECT_COMBINATORS.map((name) => `Bare Effect.${name} reference is not allowed. Call the combinator explicitly at the composition site.`),
    );
  });

  it("allows explicit Effect compositions and value constants", () => {
    const findings = analyzeText("src/example.ts", `
      const a = pipe(value, Effect.map(fn));
      const b = value.pipe(Effect.map(fn));
      const c = Effect.void;
      const d = Effect.succeed(1);
    `);

    expect(findings).toEqual([]);
  });

  it("exits nonzero from the CLI entrypoint when guardrail findings exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-env-check-patterns-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "example.ts"), "const f = flow(Effect.map(fn));");
    expect(spawnSync("git", ["init", "-q"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["add", "src/example.ts"], { cwd: directory }).status).toBe(0);

    const result = spawnSync(NODE_RUNNER_PATH, [CHECKER_PATH], { cwd: directory, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Pattern-fragmentation findings (1)");
  });
});
