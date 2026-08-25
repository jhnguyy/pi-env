import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CRUISER_PATH = fileURLToPath(
  new URL("../../node_modules/dependency-cruiser/bin/dependency-cruise.mjs", import.meta.url),
);
const KNOWN_VIOLATIONS_PATH = fileURLToPath(
  new URL("../../.dependency-cruiser-known-violations.json", import.meta.url),
);
const NODE_RUNNER_PATH = fileURLToPath(new URL("../node-run.sh", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cruiseRepository() {
  return spawnSync(
    NODE_RUNNER_PATH,
    [
      CRUISER_PATH,
      ".",
      "--output-type",
      "err",
      "--progress",
      "none",
      "--ignore-known",
      KNOWN_VIOLATIONS_PATH,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
}

describe("dependency policy", () => {
  it(
    "rejects circular dependencies and accepts an acyclic graph",
    () => {
      const directory = mkdtempSync(join(ROOT, ".dependency-policy-"));
      temporaryDirectories.push(directory);
      const first = join(directory, "first.mjs");
      const second = join(directory, "second.mjs");
      writeFileSync(first, 'import "./second.mjs";\n');
      writeFileSync(second, 'import "./first.mjs";\n');

      const cyclic = cruiseRepository();
      expect(cyclic.status).not.toBe(0);
      expect(cyclic.stdout).toContain("no-circular");

      writeFileSync(second, "export const second = 2;\n");
      const acyclic = cruiseRepository();
      expect(acyclic.status).toBe(0);
      expect(acyclic.stdout).toContain("no dependency violations found");
    },
    15_000,
  );

  it("limits the known baseline to the existing cross-extension imports", () => {
    const violations = JSON.parse(readFileSync(KNOWN_VIOLATIONS_PATH, "utf8"));
    expect(
      violations.map(({ from, to, rule }) => `${rule.name}: ${from} -> ${to}`).sort(),
    ).toEqual([
      "skill-builder-no-cross-extension-imports: .pi/extensions/skill-builder/index.ts -> .pi/extensions/subagent/control.ts",
      "skill-builder-no-cross-extension-imports: .pi/extensions/skill-builder/index.ts -> .pi/extensions/subagent/execute.ts",
    ]);
  });
});
