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

  it("bounds list details and excludes credentials from model-facing results", async () => {
    const fakeGateway = gateway();
    const result = await findTool(fakeGateway, "linear_list_issues").execute(
      "tool-call",
      { limit: 50 },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: { confirm: vi.fn(async () => true) },
      } as any,
    );

    expect((result.details as { nodes: IssueSummary[] }).nodes).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain("ENG-51");
  });

  it("confirms the exact operation before credential-backed gateway use", async () => {
    const fakeGateway = gateway();
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn(async () => false) },
    } as any;

    await expect(
      findTool(fakeGateway, "linear_get_issue").execute(
        "tool-call",
        { issueId: "ENG-1" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("credential_confirmation_required");
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Read Linear issue?",
      "Use the configured Linear credential to read ENG-1.",
      { signal: undefined },
    );
    expect(fakeGateway.issue).not.toHaveBeenCalled();
  });

  it("fails closed without an interactive confirmation surface", async () => {
    const fakeGateway = gateway();

    await expect(
      findTool(fakeGateway, "linear_viewer").execute("tool-call", {}, undefined, undefined, {
        hasUI: false,
      } as any),
    ).rejects.toThrow("credential_confirmation_required");
    expect(fakeGateway.viewer).not.toHaveBeenCalled();
  });
});
