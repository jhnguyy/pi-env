import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import reviewExtension from "../index";

const url = "https://github.com/o/r/pull/1";
function fixture() {
  let tool!: ToolDefinition;
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({
    code: 0,
    killed: false,
    truncated: false,
    stderr: "",
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            title: "Parser change",
            body: "Description end",
            state: "OPEN",
            comments: {
              totalCount: 1,
              pageInfo: { hasNextPage: false },
              nodes: [{ body: "Conversation end", author: { login: "author" } }],
            },
            reviews: {
              totalCount: 1,
              pageInfo: { hasNextPage: false },
              nodes: [{ body: "Review summary", state: "CHANGES_REQUESTED" }],
            },
            reviewThreads: {
              totalCount: 1,
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  path: "a.ts",
                  line: 42,
                  isResolved: false,
                  comments: {
                    totalCount: 7,
                    pageInfo: { hasNextPage: true },
                    nodes: [
                      { body: "Inline feedback", url: `${url}#discussion_r1` },
                      { body: "Inline reply", replyTo: { databaseId: 1 } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    }),
  });
  const on = vi.fn();
  const appendEntry = vi.fn();
  const api: Pick<ExtensionAPI, "registerCommand" | "exec" | "on" | "appendEntry"> & {
    registerTool: (value: ToolDefinition) => void;
  } = {
    registerTool: (value: ToolDefinition) => {
      tool = value;
    },
    registerCommand: (_name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = value;
    },
    exec,
    on,
    appendEntry,
  };
  // The extension only uses the API members supplied by this fixture.
  reviewExtension(api as ExtensionAPI);
  const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
  const context: Pick<ExtensionCommandContext, "cwd"> & {
    ui: Pick<ExtensionCommandContext["ui"], "notify">;
    sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getBranch">;
  } = {
    cwd: "/invocation",
    ui: { notify },
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          id: "historical-review",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          customType: "pr-review",
          data: { state: { dag: { status: "running" } } },
        },
      ],
    },
  };
  // Unused host context services are intentionally absent from this read-only fixture.
  const ctx = context as ExtensionCommandContext & Parameters<ToolDefinition["execute"]>[4];
  const execute = (params: unknown) => tool.execute("get", params, undefined, undefined, ctx);
  return { tool, command, exec, on, appendEntry, ctx, notify, execute };
}

it("registers only get and rejects retired actions before IO even for direct callers", async () => {
  const f = fixture();
  expect(Check(f.tool.parameters, { command: "pr", action: "get" })).toBe(true);
  for (const action of ["create", "post", "cleanup", "status", "walkthrough", "rerun"]) {
    expect(Check(f.tool.parameters, { command: "pr", action })).toBe(false);
    expect(await f.execute({ command: "pr", action })).toMatchObject({ isError: true });
    await f.command.handler(`pr ${action}`, f.ctx);
  }
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.appendEntry).not.toHaveBeenCalled();
  expect(f.on).not.toHaveBeenCalled();
});

it("returns description, all feedback, reply omissions and locations without managed side effects", async () => {
  const f = fixture();
  const result = await f.execute({ command: "pr", action: "get", url });
  const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
  for (const expected of [
    "Parser change",
    "Description end",
    "Conversation end",
    "Review summary",
    "CHANGES_REQUESTED",
    "Inline feedback",
    "Inline reply",
    "a.ts:42",
    "open thread",
    "7 comments; 5 omitted",
    "untrusted data",
  ])
    expect(text).toContain(expected);
  expect(result.details).toMatchObject({
    status: "ok",
    command: "get",
    url,
    pageSize: 3,
    returned: { conversation: 1, reviews: 1, inlineThreads: 1 },
  });
  expect(f.exec).toHaveBeenCalledTimes(1);
  expect(f.exec.mock.calls[0]).toMatchObject([
    "gh",
    expect.arrayContaining(["api", "graphql"]),
    { cwd: "/invocation" },
  ]);
  expect(f.appendEntry).not.toHaveBeenCalled();
});

it("supports only get [url] in the slash command and reports needs_url separately from errors", async () => {
  const f = fixture();
  await f.command.handler(`pr get ${url}`, f.ctx);
  expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Parser change"), "info");
  f.exec.mockClear();
  for (const args of ["", "pr", "pr get url extra", "pr get --cursor abc"])
    await f.command.handler(args, f.ctx);
  expect(f.exec).not.toHaveBeenCalled();
  f.exec.mockResolvedValue({
    code: 1,
    stderr: "offline",
    stdout: "",
    killed: false,
    truncated: false,
  });
  expect(await f.execute({ command: "pr", action: "get" })).toMatchObject({
    details: { status: "needs_url" },
  });
  expect(await f.execute({ command: "pr", action: "get", url })).toMatchObject({
    isError: true,
    details: { status: "failed", error: expect.stringContaining("offline") },
  });
  await f.command.handler("pr get invalid", f.ctx);
  expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("valid GitHub"), "error");
});

it("leaves isolated historical artifacts and session entries inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-retirement-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  try {
    const artifact = join(root, "pr-review", "artifacts", "historical", "state.json");
    await mkdir(join(root, "pr-review", "artifacts", "historical"), { recursive: true });
    await writeFile(artifact, "historical sentinel");
    const f = fixture();
    const entries = structuredClone(f.ctx.sessionManager.getBranch());
    await f.execute({ command: "pr", action: "get", url });
    await f.command.handler("pr cleanup historical", f.ctx);
    expect(await readFile(artifact, "utf8")).toBe("historical sentinel");
    expect(f.ctx.sessionManager.getBranch()).toEqual(entries);
    expect(f.appendEntry).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
