import { defineConfig } from "vitest/config";

const e2e = process.env.E2E === "1";
const portfolio = process.env.PI_ENV_TEST_PORTFOLIO;
const realWorkspaceCanary = process.env.REAL_WORKSPACE_CANARY === "1";

const testRoots = [
  ".pi/extensions/**/__tests__/**/*.test.ts",
  "src/**/__tests__/**/*.test.ts",
  "scripts/__tests__/**/*.test.mjs",
  "setup/__tests__/**/*.test.mjs",
];
const integrationTestRoots = [
  ".pi/extensions/**/__tests__/**/*.integration.test.ts",
  "src/**/__tests__/**/*.integration.test.ts",
  "scripts/__tests__/**/*.integration.test.mjs",
  "setup/__tests__/**/*.integration.test.mjs",
];

export default defineConfig({
  test: {
    testTimeout: e2e ? 30_000 : 5_000,
    include: e2e
      ? [
          ".pi/extensions/**/__tests__/e2e.test.ts",
          ...(realWorkspaceCanary
            ? [".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"]
            : []),
        ]
      : portfolio === "integration"
        ? integrationTestRoots
        : testRoots,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(e2e ? [] : ["**/e2e.test.ts"]),
      ...(portfolio === "unit"
        ? ["**/*.integration.test.ts", "**/*.integration.test.mjs"]
        : []),
    ],
  },
});
