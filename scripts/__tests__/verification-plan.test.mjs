import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { changedVerificationPlan, unqualifiedGlobalInputs } from "../verification-plan.mjs";

function workspace(files) {
  const cwd = mkdtempSync(join(tmpdir(), "verification-plan-"));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), "");
  }
  return cwd;
}

it("selects unit evidence for the owner and leaves qualification explicitly selectable", () => {
  const files = [
    "src/feature/__tests__/value.test.ts",
    "src/feature/__tests__/value.integration.test.ts",
    "src/feature/__tests__/e2e.test.ts",
    "src/unrelated/__tests__/value.test.ts",
  ];
  const cwd = workspace(files);
  const plan = changedVerificationPlan(
    { base: "main", files: ["src/feature/input.json"], edited: [] },
    { cwd },
  );
  expect(plan).toEqual([
    {
      label: "test:unit",
      command: "nub",
      args: [
        "run",
        "test:unit",
        "related",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--bail=1",
        "--passWithNoTests",
        "./src/feature/__tests__/e2e.test.ts",
        "./src/feature/__tests__/value.integration.test.ts",
        "./src/feature/__tests__/value.test.ts",
      ],
    },
  ]);
});

it("retains deleted inputs for reverse import selection without checking absent source", () => {
  const plan = changedVerificationPlan(
    { base: "main", files: ["src/feature/removed.ts"], edited: [] },
    { cwd: workspace(["src/feature/__tests__/unrelated.test.ts"]) },
  );
  expect(plan).toEqual([
    {
      label: "test:unit",
      command: "nub",
      args: [
        "run",
        "test:unit",
        "related",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--bail=1",
        "--passWithNoTests",
        "./src/feature/removed.ts",
      ],
    },
  ]);
});

it("reports global runtime inputs without treating documentation or component source as global", () => {
  expect(
    unqualifiedGlobalInputs([
      "README.md",
      "docs/conventions/testing.md",
      "vitest.config.ts",
      "package.json",
      "nub.lock",
      "tsconfig.json",
      "pi-build.config.json",
      "Dockerfile",
      "nix/packages.nix",
      ".github/workflows/verify.yml",
      ".pi/extensions/_shared/policy.json",
      ".pi/extensions/_shared/value.ts",
      "src/feature/value.ts",
    ]),
  ).toEqual([
    "vitest.config.ts",
    "package.json",
    "nub.lock",
    "tsconfig.json",
    "pi-build.config.json",
    "Dockerfile",
    "nix/packages.nix",
    ".github/workflows/verify.yml",
    ".pi/extensions/_shared/policy.json",
  ]);
});

it("uses reverse imports for shared source rather than adding every extension suite", () => {
  expect(
    changedVerificationPlan(
      { base: "main", files: [".pi/extensions/_shared/value.ts"], edited: [] },
      { cwd: workspace([".pi/extensions/feature/__tests__/unrelated.test.ts"]) },
    ),
  ).toEqual([
    {
      label: "test:unit",
      command: "nub",
      args: [
        "run",
        "test:unit",
        "related",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--bail=1",
        "--passWithNoTests",
        "./.pi/extensions/_shared/value.ts",
      ],
    },
  ]);
});

it.each([false, true])(
  "does not implicitly launch setup qualification (checksOnly=%s)",
  (checksOnly) => {
    expect(
      changedVerificationPlan(
        { base: "main", files: ["setup/input.json"], edited: [] },
        { cwd: workspace([]), checksOnly },
      ),
    ).toEqual([]);
  },
);
