import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { IssueSummary, LinearResourceSummary } from "../api";
import type { LinearGateway } from "../client";
import { LinearErrorCode, linearError, type LinearToolError } from "../domain";
import { createLinearTool, LinearAction } from "../tools";

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
  };
}

function tool(fakeGateway: ReturnType<typeof gateway>) {
  return createLinearTool(fakeGateway as unknown as LinearGateway);
}

async function execute(
  fakeGateway: ReturnType<typeof gateway>,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  ctx: any = {},
) {
  return tool(fakeGateway).execute("tool-call", params, signal, undefined, ctx);
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

  it("routes each action, forwards cancellation, and never asks for confirmation", async () => {
    const fakeGateway = gateway();
    const controller = new AbortController();
    const confirm = vi.fn(async () => {
      throw new Error("Linear read actions must not prompt for credential use.");
    });
    const ctx = { hasUI: true, ui: { confirm } } as any;
    const calls = [
      [LinearAction.Viewer, {}, "viewer"],
      [LinearAction.ListResources, { resourceType: "teams" }, "listResources"],
      [LinearAction.ListIssues, {}, "listIssues"],
      [LinearAction.SearchIssues, { query: "Issue" }, "searchIssues"],
      [LinearAction.GetIssue, { issueId: "ENG-1" }, "issue"],
    ] as const;

    for (const [action, params, method] of calls) {
      await expect(
        execute(fakeGateway, { action, ...params }, controller.signal, ctx),
      ).resolves.toBeDefined();
      expect(fakeGateway[method]).toHaveBeenCalledOnce();
      expect(fakeGateway[method].mock.calls[0]?.at(-1)).toBe(controller.signal);
    }
    expect(confirm).not.toHaveBeenCalled();
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
