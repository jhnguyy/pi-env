import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".pi/extensions/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
