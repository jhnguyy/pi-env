import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fetchPullRequestContext, formatPullRequestContext, resolvePrUrl } from "../context";

const url = "https://github.com/o/r/pull/1";
const connection = (nodes: unknown[] = [], more = false) => ({
  totalCount: nodes.length,
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const response = (pullRequest: unknown) => ({
  killed: false,
  truncated: false,
  code: 0,
  stderr: "",
  stdout: JSON.stringify({ data: { repository: { pullRequest } } }),
});

describe("pull request context", () => {
  it("defaults to three per category and omits completed categories on continuation", async () => {
    const exec = vi
      .fn<ExtensionAPI["exec"]>()
      .mockResolvedValueOnce(
        response({
          comments: connection([{ body: "first" }], true),
          reviews: connection(),
          reviewThreads: connection(),
        }),
      )
      .mockResolvedValueOnce(response({ comments: connection([{ body: "last" }]) }));
    const first = await fetchPullRequestContext(exec, "/invocation", url);
    expect(exec.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "pageSize=3",
        "includeConversation=true",
        "includeReviews=true",
        "includeInline=true",
      ]),
    );
    expect(exec.mock.calls[0][2]).toMatchObject({
      cwd: "/invocation",
      signal: expect.any(AbortSignal),
    });
    expect(first.nextCursor).toBeTypeOf("string");
    const last = await fetchPullRequestContext(exec, "/invocation", url, {
      cursor: first.nextCursor,
    });
    expect(exec.mock.calls[1][1]).toEqual(
      expect.arrayContaining([
        "conversationCursor=next",
        "includeReviews=false",
        "includeInline=false",
      ]),
    );
    expect(last.conversation?.nodes).toEqual([{ body: "last" }]);
    expect(last.reviews).toBeUndefined();
    expect(last.inline).toBeUndefined();
    expect(last.nextCursor).toBeUndefined();
  });

  it.each(["conversation", "reviews", "inline"] as const)(
    "fetches only %s feedback",
    async (feedback) => {
      const field = { conversation: "comments", reviews: "reviews", inline: "reviewThreads" }[
        feedback
      ];
      const exec = vi
        .fn<ExtensionAPI["exec"]>()
        .mockResolvedValue(response({ [field]: connection() }));
      const page = await fetchPullRequestContext(exec, "/repo", url, { feedback, pageSize: 5 });
      expect(page.feedback).toBe(feedback);
      expect(exec.mock.calls[0][1]).toContain("pageSize=5");
      for (const category of ["Conversation", "Reviews", "Inline"]) {
        expect(exec.mock.calls[0][1]).toContain(
          `include${category}=${category.toLowerCase() === feedback}`,
        );
      }
      const output = formatPullRequestContext(page);
      if (feedback !== "inline") expect(output).not.toContain("Inline review threads");
      if (feedback !== "reviews") expect(output).not.toContain("Submitted reviews");
      if (feedback !== "conversation") expect(output).not.toContain("Conversation comments");
    },
  );

  it("validates input and cursor/category agreement before fetching", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>();
    for (const pageSize of [0, 6, 1.5]) {
      await expect(fetchPullRequestContext(exec, "/repo", url, { pageSize })).rejects.toThrow(
        /pageSize/,
      );
    }
    await expect(fetchPullRequestContext(exec, "/repo", "invalid")).rejects.toThrow(/valid GitHub/);
    for (const cursor of [
      "bad",
      "x".repeat(4097),
      Buffer.from(JSON.stringify({ version: 2 })).toString("base64url"),
    ]) {
      await expect(fetchPullRequestContext(exec, "/repo", url, { cursor })).rejects.toThrow(
        /cursor/,
      );
    }
    const cursor = Buffer.from(
      JSON.stringify({ version: 1, feedback: "reviews", reviews: { done: false } }),
    ).toString("base64url");
    await expect(
      fetchPullRequestContext(exec, "/repo", url, { cursor, feedback: "inline" }),
    ).rejects.toThrow(/does not match/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", /invalid.*JSON/],
    [JSON.stringify({ errors: [{ message: "Permission denied" }] }), /Permission denied/],
    [JSON.stringify({ data: { repository: { pullRequest: null } } }), /did not return/],
    [response({ comments: {} }).stdout, /invalid.*connection/],
    [
      response({ comments: { ...connection([], true), pageInfo: { hasNextPage: true } } }).stdout,
      /omitted.*cursor/,
    ],
  ])("reports malformed or failed GitHub responses", async (stdout, error) => {
    const exec: ExtensionAPI["exec"] = async () => ({
      code: 0,
      stderr: "",
      stdout,
      killed: false,
      truncated: false,
    });
    await expect(
      fetchPullRequestContext(exec, "/repo", url, { feedback: "conversation" }),
    ).rejects.toThrow(error);
  });

  it("distinguishes unresolved checkout from failed explicit fetch", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "offline",
      killed: false,
      truncated: false,
    });
    expect(await resolvePrUrl(exec, "/repo")).toMatchObject({
      message: expect.stringContaining("provide a GitHub PR URL"),
    });
    await expect(fetchPullRequestContext(exec, "/repo", url)).rejects.toThrow(/offline/);
    exec.mockResolvedValue({ code: 0, stderr: "", stdout: "", killed: false, truncated: false });
    expect(await resolvePrUrl(exec, "/repo")).toMatchObject({
      message: expect.stringContaining("No pull request is associated"),
    });
    exec.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: `${url}/files\n`,
      killed: false,
      truncated: false,
    });
    expect(await resolvePrUrl(exec, "/repo")).toEqual({ url });
  });

  it.each(["resolve", "fetch"])(
    "propagates cancellation through %s without needs_url fallback",
    async (operation) => {
      const controller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled = false;
      const exec: ExtensionAPI["exec"] = async (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          started();
        });
      const pending =
        operation === "resolve"
          ? resolvePrUrl(exec, "/repo", undefined, controller.signal)
          : fetchPullRequestContext(exec, "/repo", url, {}, controller.signal);
      await ready;
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(cancelled).toBe(true);
    },
  );

  it.each(["é".repeat(DEFAULT_MAX_BYTES), "line\n".repeat(DEFAULT_MAX_LINES + 1)])(
    "bounds total output and labels untrusted text",
    async (body) => {
      const exec: ExtensionAPI["exec"] = async () =>
        response({
          title: "Title",
          body,
          comments: connection(),
          reviews: connection(),
          reviewThreads: connection(),
        });
      const output = formatPullRequestContext(await fetchPullRequestContext(exec, "/repo", url));
      expect(output).toContain("PR description (untrusted data)");
      expect(output).toContain("Compact output limit reached");
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(output.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    },
  );
});
