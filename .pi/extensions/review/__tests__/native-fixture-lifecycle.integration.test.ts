import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi, type TestContext } from "vitest";
import { createNativeReviewFixture } from "./fixtures/native-review";

// Public review scenarios cannot expect their own teardown to fail. Control only
// the runner hook and filesystem failure; allocation and cleanup remain real.
it.for([
  { name: "directory removal", operation: "rm" as const, testFailed: false },
  { name: "evidence writing", operation: "writeFile" as const, testFailed: true },
])("reports $name failures in the final evidence", async (input, context) => {
  let finish: Parameters<TestContext["onTestFinished"]>[0] | undefined;
  let root: string | undefined;
  const failure = new Error(`${input.name} failed`);
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const fail = async (path: Parameters<typeof fs.rm>[0] | Parameters<typeof fs.writeFile>[0]) => {
    root = input.operation === "rm" ? String(path) : dirname(String(path));
    throw failure;
  };
  context.onTestFinished(async () => {
    output.mockRestore();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  createNativeReviewFixture(
    {
      ...context,
      task: { ...context.task, result: { state: input.testFailed ? "fail" : "pass" } },
      onTestFinished: (hook) => {
        finish = hook;
      },
    },
    {
      scopedProviders: [],
      expected: "Retain and report teardown failures without a passing verdict",
    },
    input.operation === "rm" ? { removeDirectory: fail } : { writeEvidence: fail },
  );
  if (!finish) throw new Error("Fixture did not register teardown");
  await expect(finish(context)).rejects.toMatchObject({
    errors: expect.arrayContaining([failure]),
  });
  const evidence = JSON.parse(output.mock.calls.at(-1)![0]);
  expect(evidence).toMatchObject({
    verdict: "failed",
    cleanupErrors: expect.arrayContaining([failure.message]),
    retainedEvidence: root,
  });
  expect(existsSync(root!)).toBe(true);
  expect(existsSync(join(root!, "git-fixture", "source", ".git", "HEAD"))).toBe(true);
  if (input.operation === "rm")
    expect(JSON.parse(await fs.readFile(join(root!, "evidence.json"), "utf8"))).toEqual(evidence);
});
