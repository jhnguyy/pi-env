import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { changedVerificationPlan } from "../verification-plan.mjs";

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
    { base: "main", files: ["src/feature/input.json"], existing: [] },
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
    { base: "main", files: ["src/feature/removed.ts"], existing: [] },
    { cwd: workspace([]) },
  );
  expect(plan).toEqual([
    {
      label: "test:unit",
      command: "nub",
      args: ["run", "test:unit", "related", "--passWithNoTests", "./src/feature/removed.ts"],
    },
  ]);
});

it.each([false, true])(
  "does not implicitly launch setup qualification (checksOnly=%s)",
  (checksOnly) => {
    expect(
      changedVerificationPlan(
        { base: "main", files: ["setup/input.json"], existing: [] },
        { cwd: workspace([]), checksOnly },
      ),
    ).toEqual([]);
  },
);
