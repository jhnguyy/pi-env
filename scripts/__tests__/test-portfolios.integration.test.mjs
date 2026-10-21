import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repo = process.cwd();

async function discover(portfolio, env = {}) {
  const { stdout } = await execute(
    "scripts/node-run.sh",
    ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--json"],
    {
      cwd: repo,
      env: {
        ...process.env,
        E2E: "0",
        REAL_WORKSPACE_CANARY: "0",
        PI_ENV_TEST_PORTFOLIO: portfolio,
        ...env,
      },
      timeout: 20_000,
    },
  );
  return JSON.parse(stdout);
}

// Exercise real discovery and the batch planner; doubles cannot establish project inheritance.
describe("test portfolio discovery", () => {
  it("partitions default discovery into disjoint unit and integration portfolios usable by the safe runner", async ({
    task,
  }) => {
    expect(task.timeout).toBe(30_000);
    const all = await discover("");
    const unit = await discover("unit");
    const integration = await discover("integration");
    const files = (entries) => entries.map((entry) => entry.file).sort();

    expect(unit.length).toBeGreaterThan(0);
    expect(integration.length).toBeGreaterThan(0);
    expect(unit.every((entry) => entry.projectName === "unit")).toBe(true);
    expect(integration.every((entry) => entry.projectName === "integration")).toBe(true);
    expect(files(all)).toEqual(files([...unit, ...integration]));
    expect(new Set(files(all)).size).toBe(all.length);
    expect(files(unit)).toContain(join(repo, "src/dag/__tests__/validation.test.ts"));
    expect(files(integration)).toContain(
      join(repo, "scripts/__tests__/run-supervised-node.integration.test.mjs"),
    );

    const { stdout } = await execute(
      "scripts/node-run.sh",
      ["scripts/run-safe-tests.mjs", "--list"],
      {
        cwd: repo,
        env: { ...process.env, E2E: "0", REAL_WORKSPACE_CANARY: "0" },
        timeout: 20_000,
      },
    );
    expect(stdout).toContain("unit 1/");
    expect(stdout).toContain("integration 1/");
    expect(stdout).toContain("scripts/__tests__/run-supervised-node.integration.test.mjs");
    expect(stdout).not.toMatch(/\[(?:unit|integration)\]/);
  });

  it("selects only the explicit real-workspace canary when requested", async () => {
    const entries = await discover("", { E2E: "1", REAL_WORKSPACE_CANARY: "1" });
    expect(entries).toEqual([
      {
        file: join(repo, ".pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts"),
        projectName: "e2e",
      },
    ]);
  });
});
