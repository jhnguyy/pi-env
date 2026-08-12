import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { IssueSummary } from "../api";
import type { LinearGateway } from "../client";
import { LinearErrorCode, linearError } from "../domain";
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
    listResources: vi.fn(async () => ({
      nodes: Array.from({ length: 100 }, (_, index) => ({
        type: "teams",
        id: `team-${index + 1}`,
        name: `Team ${index + 1}`,
        key: `T${index + 1}`,
      })),
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
      totalCount: 100,
      hasMore: true,
      endCursor: "search-cursor",
    })),
    issue: vi.fn(async () => issue(1)),
    prepareCreateIssue: vi.fn(async (input) => ({
      expectedConnectionId: "connection-1",
      input: { id: "mutation-id", teamId: "team-1", title: input.title },
      preview: {
        action: "create_issue",
        connection: { id: "connection-1", workspace: "Example" },
        issue: { team: { id: "team-1", name: "Platform" }, title: input.title },
      },
    })),
    executeCreateIssue: vi.fn(async () => issue(101)),
    prepareUpdateIssue: vi.fn(async (input) => ({
      expectedConnectionId: "connection-1",
      input: { issueId: input.issueId, stateId: "state-done" },
      preview: {
        action: "update_issue",
        connection: { id: "connection-1", workspace: "Example" },
        target: { identifier: input.issueId },
        changes: { state: { id: "state-done", name: "Done" } },
      },
    })),
    executeUpdateIssue: vi.fn(async () => issue(102)),
    prepareCreateComment: vi.fn(async (input) => ({
      expectedConnectionId: "connection-1",
      input: { id: "comment-mutation-id", issueId: "id-1", body: input.body },
      preview: {
        action: "create_comment",
        connection: { id: "connection-1", workspace: "Example" },
        target: { id: "id-1", identifier: input.issueId },
        body: input.body,
      },
    })),
    executeCreateComment: vi.fn(async () => ({
      id: "comment-id",
      issueId: "id-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1#comment-id",
    })),
  };
}

function findTool(fakeGateway: ReturnType<typeof gateway>, name: string) {
  const tool = createLinearTools(fakeGateway as unknown as LinearGateway).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function context(options: { hasUI?: boolean; confirmed?: boolean } = {}) {
  return {
    cwd: "/repo",
    mode: options.hasUI === false ? "print" : "tui",
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => true,
    ui: { confirm: vi.fn(async () => options.confirmed ?? true) },
  } as any;
}

async function execute(
  fakeGateway: ReturnType<typeof gateway>,
  name: string,
  params: Record<string, unknown>,
  ctx = context(),
  toolCallId = "tool-call-1",
) {
  return findTool(fakeGateway, name).execute(toolCallId, params, undefined, undefined, ctx);
}

function textContent(result: Awaited<ReturnType<typeof execute>>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text tool output.");
  return content.text;
}

async function toolErrorCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    throw new Error("Expected tool failure.");
  } catch (error) {
    const parsed = JSON.parse((error as Error).message) as { error: { code: string } };
    return parsed.error.code;
  }
}

describeIfEnabled("linear", "Linear tools", () => {
  it("registers resource discovery, cursor reads, and separately named write tools", () => {
    expect(
      createLinearTools(gateway() as unknown as LinearGateway).map((tool) => tool.name),
    ).toEqual([
      "linear_viewer",
      "linear_list_resources",
      "linear_list_issues",
      "linear_search_issues",
      "linear_get_issue",
      "linear_create_issue",
      "linear_update_issue",
      "linear_create_comment",
    ]);
  });

  it("bounds list details and returns a continuation cursor", async () => {
    const fakeGateway = gateway();
    const result = await execute(fakeGateway, "linear_list_issues", { limit: 50 });

    expect((result.details as { nodes: IssueSummary[] }).nodes).toHaveLength(50);
    expect(result.details).toMatchObject({ endCursor: "issue-cursor", hasMore: true });
    expect(textContent(result)).toContain("use endCursor to continue");
    expect(textContent(result)).not.toContain("ENG-51");
  });

  it("bounds resource discovery and forwards its cursor", async () => {
    const fakeGateway = gateway();
    const result = await execute(fakeGateway, "linear_list_resources", {
      type: "teams",
      limit: 20,
      cursor: "previous",
    });

    expect((result.details as { nodes: unknown[] }).nodes).toHaveLength(20);
    expect(fakeGateway.listResources).toHaveBeenCalledWith(
      expect.objectContaining({ type: "teams", limit: 20, cursor: "previous" }),
      expect.anything(),
      undefined,
    );
  });

  it("returns a stable machine-readable auth error without starting login", async () => {
    const fakeGateway = gateway();
    fakeGateway.viewer.mockRejectedValue(
      linearError(LinearErrorCode.AuthRequired, "Not authenticated.", {
        recovery: "Run /linear-auth login.",
      }) as never,
    );

    expect(await toolErrorCode(execute(fakeGateway, "linear_viewer", {}))).toBe(
      LinearErrorCode.AuthRequired,
    );
  });

  it("blocks writes without interactive confirmation", async () => {
    const fakeGateway = gateway();

    expect(
      await toolErrorCode(
        execute(
          fakeGateway,
          "linear_create_issue",
          { team: "Platform", title: "Add OAuth" },
          context({ hasUI: false }),
        ),
      ),
    ).toBe(LinearErrorCode.WriteConfirmationRequired);
    expect(fakeGateway.executeCreateIssue).not.toHaveBeenCalled();
  });

  it("blocks writes when the user declines the preview", async () => {
    const fakeGateway = gateway();

    expect(
      await toolErrorCode(
        execute(
          fakeGateway,
          "linear_create_comment",
          { issueId: "ENG-1", body: "Ready" },
          context({ confirmed: false }),
        ),
      ),
    ).toBe(LinearErrorCode.WriteConfirmationRequired);
    expect(fakeGateway.executeCreateComment).not.toHaveBeenCalled();
  });

  it("checks write scope before previewing a mutation", async () => {
    const fakeGateway = gateway();
    fakeGateway.prepareUpdateIssue.mockRejectedValue(
      linearError(LinearErrorCode.InsufficientScope, "Write scope required.") as never,
    );
    const ctx = context();

    expect(
      await toolErrorCode(
        execute(fakeGateway, "linear_update_issue", { issueId: "ENG-1", state: "Done" }, ctx),
      ),
    ).toBe(LinearErrorCode.InsufficientScope);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fakeGateway.executeUpdateIssue).not.toHaveBeenCalled();
  });

  it("executes a confirmed write and returns its retry key", async () => {
    const fakeGateway = gateway();
    const ctx = context({ confirmed: true });
    const result = await execute(
      fakeGateway,
      "linear_create_issue",
      { team: "Platform", title: "Add OAuth", idempotencyKey: "intent-1" },
      ctx,
    );

    expect(fakeGateway.prepareCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ team: "Platform", title: "Add OAuth", operationKey: "intent-1" }),
      expect.anything(),
      undefined,
    );
    expect(fakeGateway.executeCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConnectionId: "connection-1" }),
      expect.anything(),
      undefined,
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Create Linear issue?",
      expect.stringContaining("team-1"),
      { signal: undefined },
    );
    expect(result.details).toMatchObject({ identifier: "ENG-101", idempotencyKey: "intent-1" });
  });

  it("rejects contradictory clear and set update fields before confirmation", async () => {
    const fakeGateway = gateway();
    const ctx = context();
    fakeGateway.prepareUpdateIssue.mockRejectedValue(
      linearError(
        LinearErrorCode.Validation,
        "assignee and clearAssignee cannot be used together.",
      ) as never,
    );

    expect(
      await toolErrorCode(
        execute(
          fakeGateway,
          "linear_update_issue",
          { issueId: "ENG-1", assignee: "agent@example.com", clearAssignee: true },
          ctx,
        ),
      ),
    ).toBe(LinearErrorCode.Validation);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});
