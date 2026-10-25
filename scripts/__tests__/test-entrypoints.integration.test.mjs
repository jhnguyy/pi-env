import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const unitFile = "src/dag/__tests__/validation.test.ts";
const integrationFile = "scripts/__tests__/test-portfolios.integration.test.mjs";

// Use real Vitest discovery without importing E2E suites or invoking a provider.
for (const [command, filters, expected, env = {}] of [
  ["test", [unitFile, integrationFile], [unitFile, integrationFile]],
  ["test:unit", [unitFile, integrationFile], [unitFile]],
  ["test:integration", [unitFile, integrationFile], [integrationFile]],
  [
    "test:e2e",
    [],
    [
      ".pi/extensions/__tests__/e2e.test.ts",
      ".pi/extensions/dev-tools/__tests__/e2e.test.ts",
      ".pi/extensions/session-manager/__tests__/e2e.test.ts",
      ".pi/extensions/share/__tests__/e2e.test.ts",
      ".pi/extensions/subagent/__tests__/e2e.test.ts",
    ],
  ],
  [
    "test:e2e",
    [".pi/extensions/__tests__/e2e.test.ts", ".pi/extensions/subagent/__tests__/e2e.test.ts"],
    [".pi/extensions/__tests__/e2e.test.ts", ".pi/extensions/subagent/__tests__/e2e.test.ts"],
  ],
  [
    "test:e2e",
    [".pi/extensions/session-manager/__tests__/e2e.test.ts"],
    [".pi/extensions/session-manager/__tests__/e2e.test.ts"],
  ],
  [
    "test:e2e",
    [],
    [".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"],
    { REAL_WORKSPACE_CANARY: "1" },
  ],
]) {
  test(`${command} ${filters.join(" ")} ${JSON.stringify(env)} selects the requested suites`, async () => {
    const { stdout } = await execute(
      "nub",
      ["run", command, "list", ...filters, "--filesOnly", "--json"],
      {
        env: {
          ...process.env,
          E2E: "0",
          REAL_WORKSPACE_CANARY: "0",
          PI_ENV_TEST_PORTFOLIO: "",
          ...env,
        },
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const entries = JSON.parse(stdout);
    expect(entries.map((entry) => entry.file.replace(`${process.cwd()}/`, "")).sort()).toEqual(
      [...expected].sort(),
    );
  });
}

test("rejects an unknown test mode before launching Vitest", async () => {
  await expect(
    execute("scripts/node-run.sh", ["scripts/test.mjs", "unknown"], {
      timeout: 5_000,
    }),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining("Unknown test mode: unknown"),
  });
});
