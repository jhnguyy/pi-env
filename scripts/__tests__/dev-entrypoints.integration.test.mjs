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
    execute("scripts/node-run.sh", ["scripts/dev.mjs", "test", "unknown"], {
      timeout: 5_000,
    }),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining("Unknown test mode: unknown"),
  });
});

for (const [command, required, excluded] of [
  ["verify", "runtime-tests: runtime tests", "runtime-tests-safe:"],
  ["verify:safe", "runtime-tests-safe: runtime tests (one worker)", "runtime-tests: runtime tests"],
  ["verify:pre-commit", "changed-code-quality:", "setup-tests:"],
  ["verify:phase", "real-workspace-semantic-canary:", "runtime-tests-safe:"],
]) {
  test(`${command} lists its portfolio without acquiring the caller's lock`, async () => {
    const { stdout } = await execute("nub", ["run", command, "--list"], {
      env: {
        ...process.env,
        PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: "",
        PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS: "0",
      },
      timeout: 15_000,
    });
    expect(stdout).toContain(required);
    expect(stdout).not.toContain(excluded);
  });
}

test("rejects an unknown verification phase before running a portfolio", async () => {
  await expect(
    execute("nub", ["run", "verify:phase", "unknown-phase"], {
      timeout: 5_000,
    }),
  ).rejects.toMatchObject({
    code: 2,
    stdout: "",
    stderr: expect.stringContaining('verify:phase: unknown phase "unknown-phase"'),
  });
});
