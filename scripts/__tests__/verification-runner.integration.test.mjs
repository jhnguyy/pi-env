import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

it("stops sequential verification at failure and preserves its exit status", async ({
  directory,
}) => {
  const marker = join(directory, "completed-steps");
  expect(runPlan([markerStep("first", marker, 7), markerStep("second", marker, 0)])).toBe(7);
  expect(await readFile(marker, "utf8")).toBe("first\n");
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
