import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type {
  CreateCommentApiInput,
  CreateIssueApiInput,
  CursorPage,
  IssuePageInput,
  LinearApi,
  LinearIdentity,
  LinearResourceSummary,
  LinearResourceType,
  ResourcePageInput,
  UpdateIssueApiInput,
} from "../api";
import type { LinearAuthAccess } from "../auth";
import { LinearGateway } from "../client";
import { LinearErrorCode, linearError } from "../domain";

const identity: LinearIdentity = {
  organization: { id: "org-1", name: "Example", urlKey: "example" },
  viewer: { id: "user-1", name: "Agent", displayName: "agent", email: "agent@example.com" },
};
const testConnection = {
  id: "connection-1",
  name: "example/agent@example.com",
  appClientId: "client-1",
  organization: identity.organization,
  viewer: identity.viewer,
  grantedScopes: ["read", "write"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function auth(): LinearAuthAccess & {
  accessToken: ReturnType<typeof vi.fn>;
  refreshAfterAuthenticationError: ReturnType<typeof vi.fn>;
} {
  return {
    accessToken: vi.fn(async () => ({
      accessToken: "token-1",
      connection: testConnection,
    })),
    refreshAfterAuthenticationError: vi.fn(async () => ({
      accessToken: "token-2",
      connection: testConnection,
    })),
  } as any;
}

function api() {
  const resourceSets: Record<LinearResourceType, LinearResourceSummary[]> = {
    teams: [
      { type: "teams", id: "team-platform", name: "Platform", key: "PLAT" },
      { type: "teams", id: "team-product", name: "Product", key: "PROD" },
    ],
    users: [
      { type: "users", id: "user-agent", name: "Agent User", email: "agent@example.com" },
      { type: "users", id: "user-other", name: "Other User", email: "other@example.com" },
    ],
    states: [
      { type: "states", id: "state-progress", name: "In Progress", teamId: "team-platform" },
      { type: "states", id: "state-done", name: "Done", teamId: "team-platform" },
    ],
    projects: [{ type: "projects", id: "project-api", name: "API" }],
    labels: [{ type: "labels", id: "label-security", name: "Security", teamId: "team-platform" }],
  };
  return {
    identity: vi.fn(async () => identity),
    viewer: vi.fn(async () => identity),
    listIssues: vi.fn(async (input: IssuePageInput) => ({
      nodes: [],
      hasMore: true,
      endCursor: `${input.cursor ?? "first"}-next`,
    })),
    searchIssues: vi.fn(async () => ({ nodes: [], hasMore: false, totalCount: 0 })),
    issue: vi.fn(async (issueId: string) => ({
      id: "issue-id",
      identifier: issueId,
      title: "Issue",
      priority: 3,
      priorityLabel: "Medium",
      teamId: "team-platform",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1",
    })),
    resources: vi.fn(
      async ({ type }: ResourcePageInput): Promise<CursorPage<LinearResourceSummary>> => ({
        nodes: resourceSets[type] ?? [],
        hasMore: false,
      }),
    ),
    createIssue: vi.fn(async (input: CreateIssueApiInput) => ({
      id: input.id,
      identifier: "ENG-2",
      title: input.title,
      priority: input.priority ?? 0,
      priorityLabel: "No priority",
      teamId: input.teamId,
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-2",
    })),
    updateIssue: vi.fn(async (input: UpdateIssueApiInput) => ({
      id: "issue-id",
      identifier: input.issueId,
      title: input.title ?? "Issue",
      priority: input.priority ?? 3,
      priorityLabel: "Medium",
      teamId: "team-platform",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1",
    })),
    createComment: vi.fn(async (input: CreateCommentApiInput) => ({
      id: input.id,
      issueId: input.issueId,
      createdAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1#comment",
    })),
  } satisfies LinearApi;
}

const ctx = { cwd: "/repo", isProjectTrusted: () => true } as any;

describeIfEnabled("linear", "Linear gateway", () => {
  it("forwards cursors and resolves human filters through the adapter port", async () => {
    const fakeAuth = auth();
    const fakeApi = api();
    const gateway = new LinearGateway(fakeAuth, () => fakeApi);

    await gateway.listIssues(
      { limit: 10, cursor: "page-1", team: "PLAT", assignee: "agent@example.com" },
      ctx,
    );

    expect(fakeApi.listIssues).toHaveBeenCalledWith({
      limit: 10,
      cursor: "page-1",
      includeArchived: undefined,
      teamId: "team-platform",
      assigneeId: "user-agent",
    });
    expect(fakeAuth.accessToken).toHaveBeenCalledWith(ctx, "read", undefined);
  });

  it("searches resource pages until it finds human-name matches", async () => {
    const fakeApi = api();
    fakeApi.resources
      .mockResolvedValueOnce({
        nodes: [{ type: "teams", id: "team-other", name: "Other" }],
        hasMore: true,
        endCursor: "page-2",
      })
      .mockResolvedValueOnce({
        nodes: [{ type: "teams", id: "team-platform", name: "Platform" }],
        hasMore: false,
      });
    const gateway = new LinearGateway(auth(), () => fakeApi);

    await expect(
      gateway.listResources({ type: "teams", query: "Platform", limit: 10 }, ctx),
    ).resolves.toMatchObject({
      nodes: [{ id: "team-platform" }],
      hasMore: false,
    });
    expect(fakeApi.resources).toHaveBeenCalledTimes(2);
  });

  it("paginates filtered resources without skipping matches from one API page", async () => {
    const fakeApi = api();
    fakeApi.resources.mockResolvedValue({
      nodes: [
        { type: "teams", id: "team-1", name: "Platform One" },
        { type: "teams", id: "team-2", name: "Platform Two" },
        { type: "teams", id: "team-3", name: "Platform Three" },
      ],
      hasMore: false,
    });
    const gateway = new LinearGateway(auth(), () => fakeApi);

    const first = await gateway.listResources({ type: "teams", query: "Platform", limit: 2 }, ctx);
    const second = await gateway.listResources(
      {
        type: "teams",
        query: "Platform",
        limit: 2,
        cursor: first.endCursor,
      },
      ctx,
    );

    expect(first.nodes.map((item) => item.id)).toEqual(["team-1", "team-2"]);
    expect(second.nodes.map((item) => item.id)).toEqual(["team-3"]);
    expect(second.hasMore).toBe(false);
  });

  it("rejects resource pagination that does not advance", async () => {
    const fakeApi = api();
    fakeApi.resources.mockResolvedValue({ nodes: [], hasMore: true, endCursor: "same" });
    const gateway = new LinearGateway(auth(), () => fakeApi);

    await expect(
      gateway.prepareCreateIssue({ operationKey: "intent", team: "Platform", title: "Issue" }, ctx),
    ).rejects.toMatchObject({ code: LinearErrorCode.Api });
    expect(fakeApi.resources).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous partial resource names with candidate details", async () => {
    const fakeApi = api();
    fakeApi.resources.mockResolvedValue({
      nodes: [
        { type: "teams", id: "team-platform", name: "Platform" },
        { type: "teams", id: "team-platform-tools", name: "Platform Tools" },
      ],
      hasMore: false,
    });
    const gateway = new LinearGateway(auth(), () => fakeApi);

    await expect(
      gateway.prepareCreateIssue({ operationKey: "intent", team: "Plat", title: "Issue" }, ctx),
    ).rejects.toMatchObject({
      code: LinearErrorCode.AmbiguousReference,
      details: { type: "teams" },
    });
    expect(fakeApi.createIssue).not.toHaveBeenCalled();
  });

  it("uses stable mutation IDs for identical retries and different IDs for changed payloads", async () => {
    const fakeApi = api();
    const gateway = new LinearGateway(auth(), () => fakeApi);

    const base = { operationKey: "intent-1", team: "Platform" };
    const first = await gateway.prepareCreateIssue({ ...base, title: "First" }, ctx);
    const retry = await gateway.prepareCreateIssue({ ...base, title: "First" }, ctx);
    const changed = await gateway.prepareCreateIssue({ ...base, title: "Changed" }, ctx);

    expect(first.input.id).toBe(retry.input.id);
    expect(changed.input.id).not.toBe(first.input.id);
    expect(first.preview).toMatchObject({
      connection: { id: "connection-1", workspace: "Example" },
      issue: { team: { id: "team-platform", name: "Platform" }, title: "First" },
    });
  });

  it("blocks a confirmed write if connection selection changes", async () => {
    const fakeAuth = auth();
    const fakeApi = api();
    const gateway = new LinearGateway(fakeAuth, () => fakeApi);
    const prepared = await gateway.prepareCreateIssue(
      { operationKey: "intent-1", team: "Platform", title: "Issue" },
      ctx,
    );
    fakeAuth.accessToken.mockResolvedValue({
      accessToken: "token-1",
      connection: { ...testConnection, id: "connection-2" },
    });

    await expect(gateway.executeCreateIssue(prepared, ctx)).rejects.toMatchObject({
      code: LinearErrorCode.Conflict,
    });
    expect(fakeApi.createIssue).not.toHaveBeenCalled();
  });

  it("validates contradictory update fields at the gateway boundary", async () => {
    const fakeApi = api();
    const gateway = new LinearGateway(auth(), () => fakeApi);

    await expect(
      gateway.prepareUpdateIssue(
        {
          issueId: "ENG-1",
          assignee: "agent@example.com",
          clearAssignee: true,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: LinearErrorCode.Validation });
    expect(fakeApi.issue).not.toHaveBeenCalled();
  });

  it("retries one SDK authentication failure through the auth port", async () => {
    const fakeAuth = auth();
    const expiredApi = api();
    expiredApi.viewer.mockRejectedValue(linearError(LinearErrorCode.AuthRequired, "Expired."));
    const refreshedApi = api();
    const factory = vi.fn().mockReturnValueOnce(expiredApi).mockReturnValueOnce(refreshedApi);
    const gateway = new LinearGateway(fakeAuth, factory);

    await expect(gateway.viewer(ctx)).resolves.toEqual(identity);
    expect(fakeAuth.refreshAfterAuthenticationError).toHaveBeenCalledWith(ctx, "read", undefined);
    expect(factory).toHaveBeenNthCalledWith(1, "token-1", undefined);
    expect(factory).toHaveBeenNthCalledWith(2, "token-2", undefined);
  });
});
