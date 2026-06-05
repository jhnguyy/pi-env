import { defineConfig } from "vitest/config";

const e2e = process.env.E2E === "1";

export default defineConfig({
  test: {
    include: e2e
      ? [".pi/extensions/**/__tests__/e2e.test.ts"]
      : [".pi/extensions/**/__tests__/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(e2e ? [] : ["**/e2e.test.ts"]),
    ],
  },
});
