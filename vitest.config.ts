import { defineConfig } from "vitest/config";

const e2e = process.env.E2E === "1";
const realWorkspaceCanary = process.env.REAL_WORKSPACE_CANARY === "1";

export default defineConfig({
  test: {
    setupFiles: [".pi/extensions/__tests__/setup.ts"],
    testTimeout: e2e ? 30_000 : 5_000,
    include: e2e
      ? [
          ".pi/extensions/**/__tests__/e2e.test.ts",
          ...(realWorkspaceCanary
            ? [".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"]
            : []),
        ]
      : [
          ".pi/extensions/**/__tests__/**/*.test.ts",
          "src/analyze/__tests__/**/*.test.ts",
          "src/process/__tests__/**/*.test.ts",
          "scripts/__tests__/**/*.test.mjs",
          "setup/__tests__/**/*.test.mjs",
        ],
    exclude: ["**/node_modules/**", "**/dist/**", ...(e2e ? [] : ["**/e2e.test.ts"])],
  },
});
