import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

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
    project: ["unit", "integration"],
    pool: "threads",
    maxWorkers: 4,
    testTimeout: 30_000,
    env: { TMPDIR: realpathSync(tmpdir()) },
    exclude: ["**/node_modules/**", "**/dist/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          testTimeout: 5_000,
          include: testRoots,
          exclude: [
            "**/e2e.test.ts",
            "**/*.e2e.test.ts",
            "**/*.integration.test.ts",
            "**/*.integration.test.mjs",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: integrationTestRoots,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          maxWorkers: 1,
          include: [".pi/extensions/**/__tests__/e2e.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "real-workspace-canary",
          maxWorkers: 1,
          include: [".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"],
        },
      },
    ],
  },
});
