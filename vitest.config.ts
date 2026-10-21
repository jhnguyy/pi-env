import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
    env: { TMPDIR: realpathSync(tmpdir()) },
    exclude: ["**/node_modules/**", "**/dist/**"],
    projects: e2e
      ? [
          {
            extends: true,
            test: {
              name: "e2e",
              testTimeout: 30_000,
              include: realWorkspaceCanary
                ? [".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"]
                : [".pi/extensions/**/__tests__/e2e.test.ts"],
            },
          },
        ]
      : [
          ...(portfolio === "integration"
            ? []
            : [
                {
                  extends: true,
                  test: {
                    name: "unit",
                    testTimeout: 5_000,
                    include: testRoots,
                    exclude: [
                      "**/e2e.test.ts",
                      "**/*.integration.test.ts",
                      "**/*.integration.test.mjs",
                    ],
                  },
                },
              ]),
          ...(portfolio === "unit"
            ? []
            : [
                {
                  extends: true,
                  test: {
                    name: "integration",
                    testTimeout: 30_000,
                    include: integrationTestRoots,
                  },
                },
              ]),
        ],
  },
});
