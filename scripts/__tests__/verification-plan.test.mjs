import { expect, it } from "vitest";
import { unqualifiedGlobalInputs } from "../verification-plan.mjs";

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
      "extensions/_shared/policy.json",
      "extensions/_shared/value.ts",
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
    "extensions/_shared/policy.json",
  ]);
});
