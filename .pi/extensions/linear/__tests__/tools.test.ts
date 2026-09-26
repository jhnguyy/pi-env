import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { IssueSummary, LinearResourceSummary } from "../api";
import { LinearErrorCode, linearError, type LinearToolError } from "../domain";
import { createLinearContract, LinearAction, type LinearToolGateway } from "../tools";

function issue(number: number): IssueSummary {
  return {
    id: `id-${number}`,
    identifier: `ENG-${number}`,
    title: `Issue ${number}`,
    priority: 3,
    priorityLabel: "Medium",
    state: { id: "state-id", name: "Todo" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: `https://linear.app/example/issue/ENG-${number}`,
  };
}

function resource(number: number): LinearResourceSummary {
  return { id: `team-${number}`, type: "teams", name: `Team ${number}`, key: `T${number}` };
}

function gateway() {
  return {
    viewer: vi.fn(async () => ({
      organization: { id: "org-id", name: "Example", urlKey: "example" },
      viewer: {
        id: "user-id",
        name: "Agent User",
        displayName: "agent",
        email: "agent@example.com",
      },
    })),
    listResources: vi.fn(async () => ({
      nodes: Array.from({ length: 100 }, (_, index) => resource(index + 1)),
      hasMore: true,
      endCursor: "resource-cursor",
    })),
    listIssues: vi.fn(async () => ({
      nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
      hasMore: true,
      endCursor: "issue-cursor",
    })),
    searchIssues: vi.fn(async () => ({
      nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
      hasMore: true,
      endCursor: "search-cursor",
      totalCount: 100,
    })),
    issue: vi.fn(async () => issue(1)),
    createIssue: vi.fn(async () => issue(2)),
    updateIssue: vi.fn(async () => issue(1)),
    createComment: vi.fn(async () => ({
      id: "comment-1",
      issueId: "id-1",
      createdAt: "2026-01-01",
      url: "https://linear.app/comment/1",
    })),
  } satisfies LinearToolGateway;
}

function tool(fakeGateway: ReturnType<typeof gateway>) {
  return createLinearContract(fakeGateway);
}

async function execute(
  fakeGateway: ReturnType<typeof gateway>,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return tool(fakeGateway).execute(params as never, { cwd: "/repo", signal });
}

describeIfEnabled("linear", "Linear tool", () => {
  it("exposes one tool with the five read actions", () => {
    const definition = tool(gateway());
    expect(definition.name).toBe("linear");
    for (const action of Object.values(LinearAction)) {
      expect(Check(definition.parameters, { action })).toBe(true);
    }
    expect(Check(definition.parameters, {})).toBe(false);
    expect(Check(definition.parameters, { action: "create-issue" })).toBe(false);
  });

  it("routes each action and forwards cancellation", async () => {
    const fakeGateway = gateway();
    const controller = new AbortController();
    const calls = [
      [LinearAction.Viewer, {}, "viewer"],
      [LinearAction.ListResources, { resourceType: "teams" }, "listResources"],
      [LinearAction.ListIssues, {}, "listIssues"],
      [LinearAction.SearchIssues, { query: "Issue" }, "searchIssues"],
      [LinearAction.GetIssue, { issueId: "ENG-1" }, "issue"],
    ] as const;

    for (const [action, params, method] of calls) {
      await expect(
        execute(fakeGateway, { action, ...params }, controller.signal),
      ).resolves.toBeDefined();
      expect(fakeGateway[method]).toHaveBeenCalledOnce();
      expect(fakeGateway[method].mock.calls[0]?.at(-1)).toBe(controller.signal);
    }
  });

  it.each([
    [LinearAction.ListResources, { resourceType: "teams", limit: 50 }, "T51"],
    [LinearAction.ListIssues, { limit: 50 }, "ENG-51"],
    [LinearAction.SearchIssues, { query: "Issue", limit: 50 }, "ENG-51"],
  ] as const)(
    "bounds %s results and preserves the continuation cursor",
    async (action, params, excluded) => {
      const result = await execute(gateway(), { action, ...params });
      expect((result.details as { nodes: unknown[] }).nodes).toHaveLength(50);
      expect((result.details as { endCursor?: string }).endCursor).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(excluded);
    },
  );

  it("rejects action-specific parameter errors before gateway access", async () => {
    const fakeGateway = gateway();
    await expect(
      execute(fakeGateway, { action: LinearAction.Viewer, issueId: "ENG-1" }),
    ).rejects.toMatchObject({
      name: "LinearToolError",
      envelope: { error: { code: LinearErrorCode.Validation } },
    });
    expect(fakeGateway.viewer).not.toHaveBeenCalled();
    expect(fakeGateway.issue).not.toHaveBeenCalled();
  });

  it("routes collection actions and rejects invalid pairs before network access", async () => {
    const fakeGateway = gateway();
    await execute(fakeGateway, { collection: "issues", action: "read", issueId: "ENG-1" });
    await execute(fakeGateway, { collection: "issues", action: "search", query: "bug" });
    await execute(fakeGateway, { collection: "resources", action: "list", resourceType: "teams" });
    expect(fakeGateway.issue).toHaveBeenCalledOnce();
    expect(fakeGateway.searchIssues).toHaveBeenCalledOnce();
    expect(fakeGateway.listResources).toHaveBeenCalledOnce();
    await expect(
      execute(fakeGateway, { collection: "comments", action: "search", query: "bug" }),
    ).rejects.toMatchObject({ name: "LinearToolError" });
    expect(fakeGateway.searchIssues).toHaveBeenCalledOnce();
  });

  it("validates mutations before the gateway and forwards patches and cancellation", async () => {
    const fakeGateway = gateway();
    for (const params of [
      { collection: "issues", action: "create", team: "PLAT", title: " " },
      { collection: "issues", action: "update", issueId: "ENG-1" },
      { collection: "comments", action: "create", issueId: "ENG-1", body: " " },
      { collection: "issues", action: "create", team: "PLAT", title: "New", issueId: "ENG-1" },
    ]) {
      await expect(execute(fakeGateway, params)).rejects.toMatchObject({ name: "LinearToolError" });
    }
    expect(fakeGateway.createIssue).not.toHaveBeenCalled();
    expect(fakeGateway.updateIssue).not.toHaveBeenCalled();
    expect(fakeGateway.createComment).not.toHaveBeenCalled();

    const signal = new AbortController().signal;
    await execute(
      fakeGateway,
      { collection: "issues", action: "create", team: "PLAT", title: "New" },
      signal,
    );
    await execute(
      fakeGateway,
      {
        collection: "issues",
        action: "update",
        issueId: "ENG-1",
        description: "New description",
        assignee: null,
      },
      signal,
    );
    await execute(
      fakeGateway,
      { collection: "comments", action: "create", issueId: "ENG-1", body: "A comment" },
      signal,
    );
    expect(fakeGateway.createIssue).toHaveBeenCalledWith({ team: "PLAT", title: "New" }, signal);
    expect(fakeGateway.updateIssue).toHaveBeenCalledWith(
      { issueId: "ENG-1", description: "New description", assignee: null },
      signal,
    );
    expect(fakeGateway.createComment).toHaveBeenCalledWith(
      { issueId: "ENG-1", body: "A comment" },
      signal,
    );
  });

  it("preserves typed gateway failures", async () => {
    const fakeGateway = gateway();
    fakeGateway.issue.mockRejectedValueOnce(
      linearError(LinearErrorCode.Forbidden, "Issue access is forbidden.", {
        recovery: "Request access.",
      }),
    );
    await expect(
      execute(fakeGateway, { action: LinearAction.GetIssue, issueId: "ENG-1" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LinearToolError>>({
        name: "LinearToolError",
        envelope: {
          error: {
            code: LinearErrorCode.Forbidden,
            message: "Issue access is forbidden.",
            retryable: false,
            recovery: "Request access.",
          },
        },
      }),
    );
  });
});
