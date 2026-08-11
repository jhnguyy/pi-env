import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { IssueSummary } from "../client";
import { createLinearTools, type LinearOperations } from "../tools";

function issue(number: number, description?: string): IssueSummary {
  return {
    id: `id-${number}`,
    identifier: `ENG-${number}`,
    title: `Issue ${number}`,
    ...(description ? { description } : {}),
    priority: 3,
    priorityLabel: "Medium",
    state: { id: "state-id", name: "Todo" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: `https://linear.app/example/issue/ENG-${number}`,
  };
}

function gateway(): LinearOperations {
  return {
    viewer: vi.fn(async () => ({
      id: "user-id",
      name: "Agent User",
      displayName: "agent",
      email: "agent@example.com",
      workspace: { id: "workspace-id", name: "Example", urlKey: "example" },
    })),
    listIssues: vi.fn(async () => ({
      issues: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
      hasMore: true,
    })),
    searchIssues: vi.fn(async () => ({
      issues: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
      totalCount: 100,
      hasMore: true,
    })),
    issue: vi.fn(async (issueId) =>
      issue(Number(issueId.split("-").at(-1) ?? 1), "Issue description"),
    ),
    createIssue: vi.fn(async () =>
      issue(101, "A description that must not be repeated in a mutation result."),
    ),
    updateIssue: vi.fn(async () =>
      issue(102, "A description that must not be repeated in a mutation result."),
    ),
    createComment: vi.fn(
      async () =>
        ({
          id: "comment-id",
          issueId: "id-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          url: "https://linear.app/example/issue/ENG-1#comment-id",
          body: "A body that must not be repeated in a mutation result.",
        }) as any,
    ),
  };
}

function findTool(operations: LinearOperations, name: string) {
  const tool = createLinearTools(operations).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

const ctx = { hasUI: false, mode: "print", ui: {} } as any;

async function execute(
  operations: LinearOperations,
  name: string,
  params: Record<string, unknown>,
) {
  return findTool(operations, name).execute("call-id", params, undefined, undefined, ctx);
}

function textContent(result: Awaited<ReturnType<typeof execute>>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text tool output.");
  return content.text;
}

describeIfEnabled("linear", "Linear tools", () => {
  it("registers the initial read and write capability surface", () => {
    expect(createLinearTools(gateway()).map((tool) => tool.name)).toEqual([
      "linear_viewer",
      "linear_list_issues",
      "linear_search_issues",
      "linear_get_issue",
      "linear_create_issue",
      "linear_update_issue",
      "linear_create_comment",
    ]);
  });

  it("bounds list results and stored details to the requested limit", async () => {
    const operations = gateway();
    const result = await execute(operations, "linear_list_issues", { limit: 50 });

    expect((result.details as { issues: IssueSummary[] }).issues).toHaveLength(50);
    expect(textContent(result)).toContain("ENG-50");
    expect(textContent(result)).not.toContain("ENG-51");
    expect(operations.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
      ctx,
      undefined,
    );
  });

  it("uses a bounded default for issue searches", async () => {
    const operations = gateway();
    const result = await execute(operations, "linear_search_issues", { query: "authentication" });

    expect((result.details as { issues: IssueSummary[] }).issues).toHaveLength(20);
    expect(operations.searchIssues).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, query: "authentication" }),
      ctx,
      undefined,
    );
  });

  it("keeps issue creation responses concise", async () => {
    const result = await execute(gateway(), "linear_create_issue", {
      teamId: "team-id",
      title: "Add OAuth",
    });

    expect(result.details).toMatchObject({ identifier: "ENG-101", title: "Issue 101" });
    expect(result.details).not.toHaveProperty("description");
    expect(textContent(result)).not.toContain("must not be repeated");
  });

  it("rejects an issue update with no changed fields", async () => {
    const operations = gateway();

    await expect(execute(operations, "linear_update_issue", { issueId: "ENG-1" })).rejects.toThrow(
      "at least one field",
    );
    expect(operations.updateIssue).not.toHaveBeenCalled();
  });

  it("keeps comment creation responses concise", async () => {
    const result = await execute(gateway(), "linear_create_comment", {
      issueId: "ENG-1",
      body: "Created by Pi",
    });

    expect(result.details).toEqual({
      id: "comment-id",
      issueId: "id-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1#comment-id",
    });
    expect(textContent(result)).not.toContain("must not be repeated");
  });
});
