import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

import jitCatchExtension from "../index";
import type * as runner from "../runner";

const processRunner = vi.hoisted(() => vi.fn());
const extensionRunner = vi.hoisted(() => vi.fn());

vi.mock("../runner", async () => {
  const actual = await vi.importActual<typeof runner>("../runner");
  return {
    ...actual,
    platformJitRunner: (...args: Parameters<typeof actual.platformJitRunner>) =>
      processRunner(...args),
    runForExtensionEffect: (...args: Parameters<typeof actual.runForExtensionEffect>) =>
      extensionRunner(...args),
  };
});

const pathCases = [
  {
    label: "project-local",
    path: ".pi/extensions/work-tracker/index.ts",
    extension: "work-tracker",
  },
  {
    label: "installed",
    path: ".pi/agent/extensions/dev-tools/server.ts",
    extension: "dev-tools",
  },
] as const;

const noWorkflowCases = [
  {
    label: "test-only",
    diff: changedFiles(".pi/extensions/demo/__tests__/demo.test.ts"),
    message: "No changed files found in the diff.",
  },
  {
    label: "deletion-only",
    diff: [
      "diff --git a/.pi/extensions/demo/old.ts b/.pi/extensions/demo/old.ts",
      "--- a/.pi/extensions/demo/old.ts",
      "+++ /dev/null",
    ].join("\n"),
    message: "No changed files found in the diff.",
  },
  {
    label: "non-extension-only",
    diff: changedFiles("README.md"),
    message: "Diff only touches non-extension files — jit-catch does not apply.",
  },
  {
    label: "node_modules pseudo-extension",
    diff: changedFiles("extensions/node_modules/package/index.js"),
    message: "No changed files found in the diff.",
  },
] as const;

const acquisitionCases = [
  {
    source: "unstaged",
    params: {},
    cwd: "/context",
    gitArgs: ["diff"],
  },
  {
    source: "staged",
    params: { diff_source: "staged", git_cwd: "/explicit" },
    cwd: "/explicit",
    gitArgs: ["diff", "--cached"],
  },
  {
    source: "commit",
    params: { diff_source: "commit", commit: "abc123" },
    cwd: "/context",
    gitArgs: ["show", "abc123"],
  },
] as const;

beforeEach(() => {
  processRunner.mockReset();
  extensionRunner.mockReset();
  extensionRunner.mockImplementation((extension) =>
    Effect.succeed({
      extName: extension.name,
      passed: true,
      testOutput: "ok",
      testPath: null,
    }),
  );
});

function changedFiles(...paths: string[]): string {
  return paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    )
    .join("\n");
}

function mixedExtensionDiff(): string {
  const alphaIndex = ".pi/extensions/alpha/index.ts";
  return changedFiles(
    alphaIndex,
    alphaIndex,
    ".pi/extensions/alpha/types.ts",
    ".pi/extensions/alpha/__tests__/alpha.test.ts",
    ".pi/extensions/beta/client.ts",
    "extensions/node_modules/package/index.js",
    "README.md",
  );
}

function registeredTool() {
  const tools: any[] = [];
  const pi = {
    registerTool: vi.fn((tool: any) => tools.push(tool)),
    events: { emit: vi.fn() },
    on: vi.fn(),
  };
  jitCatchExtension(pi as any);
  return tools[0];
}

function execute(params: Record<string, unknown>, cwd = "/context") {
  return registeredTool().execute(
    "call-id",
    params,
    undefined,
    undefined,
    { cwd },
  );
}

it.each(pathCases)(
  "$label raw path selects its extension source through the registered tool",
  async ({ path, extension }) => {
    const result = await execute({ diff: changedFiles(path) }, "/workspace");

    expect(extensionRunner).toHaveBeenCalledOnce();
    expect(extensionRunner.mock.calls[0][0]).toEqual({
      name: extension,
      changedFiles: [path],
    });
    expect(extensionRunner.mock.calls[0][3]).toBe("/workspace");
    expect(result.details).toMatchObject({
      results: [{ extName: extension, passed: true }],
      anyFailed: false,
    });
  },
);

it("groups and admits source files from a mixed raw diff", async () => {
  const result = await execute({ diff: mixedExtensionDiff() });

  expect(extensionRunner).toHaveBeenCalledTimes(2);
  expect(extensionRunner.mock.calls.map((call) => call[0])).toEqual([
    {
      name: "alpha",
      changedFiles: [
        ".pi/extensions/alpha/index.ts",
        ".pi/extensions/alpha/types.ts",
      ],
    },
    {
      name: "beta",
      changedFiles: [".pi/extensions/beta/client.ts"],
    },
  ]);
  expect(result.content[0].text).toContain("non-extension files (ignored)");
});

it("limits a mixed raw diff to the requested extension", async () => {
  const result = await execute({ diff: mixedExtensionDiff(), ext_name: "alpha" });

  expect(extensionRunner).toHaveBeenCalledOnce();
  expect(extensionRunner.mock.calls[0][0].name).toBe("alpha");
  expect(result.details.results).toEqual([
    expect.objectContaining({ extName: "alpha", passed: true }),
  ]);
});

it.each(noWorkflowCases)(
  "$label raw diff does not start a catching-test workflow",
  async ({ diff, message }) => {
    const result = await execute({ diff });

    expect(result.details).toEqual({ error: message });
    expect(extensionRunner).not.toHaveBeenCalled();
    expect(processRunner).not.toHaveBeenCalled();
  },
);

it.each(acquisitionCases)(
  "$source acquisition uses the selected Git mode and cwd",
  async ({ params, cwd, gitArgs }) => {
    processRunner.mockImplementation((_command, args) =>
      Effect.succeed(
        args[0] === "rev-parse"
          ? { code: 0, stdout: "/repo/root\n", stderr: "" }
          : {
              code: 0,
              stdout: changedFiles(".pi/extensions/demo/index.ts"),
              stderr: "",
            },
      ),
    );

    await execute(params);

    expect(processRunner).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    expect(processRunner).toHaveBeenNthCalledWith(2, "git", gitArgs, { cwd });
    expect(extensionRunner.mock.calls[0][3]).toBe("/repo/root");
  },
);

it("requires a commit before registered commit acquisition starts", async () => {
  processRunner.mockReturnValue(Effect.succeed({ code: 0, stdout: "/repo/root\n", stderr: "" }));

  const result = await execute({ diff_source: "commit" });

  expect(result.details).toEqual({ error: "diff_source='commit' requires a commit SHA" });
  expect(processRunner).toHaveBeenCalledOnce();
  expect(processRunner.mock.calls[0][1]).toEqual(["rev-parse", "--show-toplevel"]);
  expect(extensionRunner).not.toHaveBeenCalled();
});

it("translates a registered Git acquisition failure", async () => {
  processRunner.mockImplementation((_command, args) =>
    Effect.succeed(
      args[0] === "rev-parse"
        ? { code: 0, stdout: "/repo/root\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "bad revision" },
    ),
  );

  const result = await execute({ diff_source: "commit", commit: "missing" });

  expect(result.details).toEqual({ error: "git show failed (exit 1): bad revision" });
  expect(extensionRunner).not.toHaveBeenCalled();
});

it.each([
  { label: "explicit git cwd", params: { git_cwd: "/explicit" }, root: "/explicit" },
  { label: "context cwd", params: {}, root: "/context" },
])("raw diff bypasses Git and uses $label", async ({ params, root }) => {
  const result = await execute({
    ...params,
    diff: changedFiles(".pi/extensions/demo/index.ts"),
  });

  expect(processRunner).not.toHaveBeenCalled();
  expect(extensionRunner.mock.calls[0][3]).toBe(root);
  expect(result.details).toMatchObject({ anyFailed: false });
});
