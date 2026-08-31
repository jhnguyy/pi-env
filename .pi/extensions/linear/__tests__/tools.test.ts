import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { IssueSummary } from "../api";
import type { LinearGateway } from "../client";
import { createLinearTools } from "../tools";

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
    listResources: vi.fn(async () => ({ nodes: [], hasMore: false })),
    listIssues: vi.fn(async () => ({
      nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
      hasMore: true,
      endCursor: "issue-cursor",
    })),
    searchIssues: vi.fn(async () => ({ nodes: [], hasMore: false, totalCount: 0 })),
    issue: vi.fn(async () => issue(1)),
  };
}

function findTool(fakeGateway: ReturnType<typeof gateway>, name: string) {
  const tool = createLinearTools(fakeGateway as unknown as LinearGateway).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

describeIfEnabled("linear", "Linear read tools", () => {
  it("registers only focused read tools", () => {
    expect(
      createLinearTools(gateway() as unknown as LinearGateway).map((tool) => tool.name),
    ).toEqual([
      "linear_viewer",
      "linear_list_resources",
      "linear_list_issues",
      "linear_search_issues",
      "linear_get_issue",
    ]);
  });

  it("bounds list details", async () => {
    const fakeGateway = gateway();
    const result = await findTool(fakeGateway, "linear_list_issues").execute(
      "tool-call",
      { limit: 50 },
      undefined,
      undefined,
      {} as any,
    );

    expect((result.details as { nodes: IssueSummary[] }).nodes).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain("ENG-51");
  });

  it("executes every read tool without asking for credential confirmation", async () => {
    const fakeGateway = gateway();
    const confirm = vi.fn(async () => {
      throw new Error("Linear read tools must not prompt for credential use.");
    });
    const ctx = { hasUI: true, ui: { confirm } } as any;
    const calls = [
      ["linear_viewer", {}],
      ["linear_list_resources", { type: "teams" }],
      ["linear_list_issues", { limit: 1 }],
      ["linear_search_issues", { query: "Issue" }],
      ["linear_get_issue", { issueId: "ENG-1" }],
    ] as const;

    for (const [name, params] of calls) {
      await expect(
        findTool(fakeGateway, name).execute("tool-call", params, undefined, undefined, ctx),
      ).resolves.toBeDefined();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(fakeGateway.viewer).toHaveBeenCalledOnce();
    expect(fakeGateway.listResources).toHaveBeenCalledOnce();
    expect(fakeGateway.listIssues).toHaveBeenCalledOnce();
    expect(fakeGateway.searchIssues).toHaveBeenCalledOnce();
    expect(fakeGateway.issue).toHaveBeenCalledOnce();
  });
});
