import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runPlan } from "../verification-runner.mjs";

const node = process.env.PI_ENV_NODE_BIN ?? process.execPath;
const it = test.extend({
  directory: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "verification-runner-"));
    try {
      await use(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

function markerStep(id, marker, exitCode) {
  return {
    label: id,
    command: node,
    args: [
      "-e",
      'require("node:fs").appendFileSync(process.argv[1], process.argv[2]); process.exit(Number(process.argv[3]));',
      marker,
      `${id}\n`,
      String(exitCode),
    ],
  };
}

it("stops at failure, preserves its exit status, and distinguishes unrun checks", async ({
  directory,
}) => {
  const marker = join(directory, "completed-steps");
  expect(
    runPlan([markerStep("first", marker, 7), markerStep("second", marker, 0)], {
      reportDirectory: directory,
    }),
  ).toBe(7);
  expect(await readFile(marker, "utf8")).toBe("first\n");
  const summary = await readFile(join(directory, "verification.md"), "utf8");
  expect(summary).toMatch(/first.*failed/);
  expect(summary).toMatch(/second.*not run/);
});

it("stops when a step cannot start", async ({ directory }) => {
  const marker = join(directory, "completed-steps");
  expect(
    runPlan([
      { label: "missing", command: join(directory, "missing"), args: [] },
      markerStep("later", marker, 0),
    ]),
  ).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

it("gives tests an evidence destination and reports their completed result", async ({
  directory,
}) => {
  expect(
    runPlan(
      [
        {
          label: "test:example",
          command: node,
          args: [
            "-e",
            'require("node:fs").writeFileSync(process.env.PI_ENV_TEST_REPORT, "test-result")',
          ],
        },
      ],
      { reportDirectory: directory },
    ),
  ).toBe(0);
  const reports = (await readdir(directory)).filter((file) => file.endsWith(".xml"));
  expect(reports).toHaveLength(1);
  expect(await readFile(join(directory, reports[0]), "utf8")).toBe("test-result");
  expect(await readFile(join(directory, "verification.md"), "utf8")).toMatch(
    /test:example.*passed/,
  );
});
