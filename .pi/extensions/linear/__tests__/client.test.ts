import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { CredentialErrorCode, type CredentialSource } from "../../_shared/credential-source";
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
import { LinearGateway } from "../client";

const SENTINEL = "SECRET_SENTINEL_DO_NOT_LEAK";
const identity: LinearIdentity = {
  organization: { id: "org-1", name: "Example", urlKey: "example" },
  viewer: { id: "user-1", name: "Agent", displayName: "agent", email: "agent@example.com" },
};

function credentials(): CredentialSource & {
  has: ReturnType<typeof vi.fn>;
  use: ReturnType<typeof vi.fn>;
} {
  return {
    has: vi.fn(() => true),
    use: vi.fn(async (_request, consume) => consume(SENTINEL)),
  };
}

function api() {
  const resourceSets: Record<LinearResourceType, LinearResourceSummary[]> = {
    teams: [{ type: "teams", id: "team-platform", name: "Platform", key: "PLAT" }],
    users: [{ type: "users", id: "user-agent", name: "Agent User", email: "agent@example.com" }],
    states: [],
    projects: [],
    labels: [],
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
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/example/issue/ENG-1",
    })),
    resources: vi.fn(
      async ({ type }: ResourcePageInput): Promise<CursorPage<LinearResourceSummary>> => ({
        nodes: resourceSets[type],
        hasMore: false,
      }),
    ),
    createIssue: vi.fn(async (_input: CreateIssueApiInput) => ({
      id: "issue-id",
      identifier: "ENG-1",
      title: "New",
      priority: 0,
      priorityLabel: "None",
      updatedAt: "2026-01-01",
      url: "https://linear.app/example/issue/ENG-1",
    })),
    updateIssue: vi.fn(async (_input: UpdateIssueApiInput) => ({
      id: "issue-id",
      identifier: "ENG-1",
      title: "Changed",
      priority: 0,
      priorityLabel: "None",
      updatedAt: "2026-01-01",
      url: "https://linear.app/example/issue/ENG-1",
    })),
    createComment: vi.fn(async (_input: CreateCommentApiInput) => ({
      id: "comment-id",
      issueId: "issue-id",
      createdAt: "2026-01-01",
      url: "https://linear.app/example/comment/1",
    })),
  } satisfies LinearApi;
}

describeIfEnabled("linear", "Linear credential source gateway", () => {
  it("uses the fixed linear.apiKey name and keeps the value inside the API factory", async () => {
    const source = credentials();
    const fakeApi = api();
    const createApi = vi.fn((apiKey: string) => {
      expect(apiKey).toBe(SENTINEL);
      return fakeApi;
    });
    const gateway = new LinearGateway(() => source, createApi);

    await expect(gateway.viewer()).resolves.toEqual(identity);
    expect(source.has).toHaveBeenCalledWith("linear.apiKey");
    expect(source.use).toHaveBeenCalledWith(
      { name: "linear.apiKey", consumer: "linear" },
      expect.any(Function),
      undefined,
    );
  });

  it("rejects an absent Linear credential before credential retrieval or API access", async () => {
    const source = credentials();
    source.has.mockReturnValue(false);
    const createApi = vi.fn(() => api());
    const gateway = new LinearGateway(() => source, createApi);

    await expect(gateway.viewer()).rejects.toMatchObject({
      code: CredentialErrorCode.NotConfigured,
      name: "linear.apiKey",
    });
    expect(source.has).toHaveBeenCalledWith("linear.apiKey");
    expect(source.use).not.toHaveBeenCalled();
    expect(createApi).not.toHaveBeenCalled();
  });

  it("resolves write references, generates stable create IDs, and does not change unspecified fields", async () => {
    const fakeApi = api();
    const gateway = new LinearGateway(
      () => credentials(),
      () => fakeApi,
    );
    await gateway.createIssue({ team: "PLAT", title: "New", assignee: "agent@example.com" });
    expect(fakeApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        teamId: "team-platform",
        title: "New",
        assigneeId: "user-agent",
      }),
    );
    await gateway.updateIssue({ issueId: "ENG-1", title: "Changed", assignee: null });
    expect(fakeApi.updateIssue).toHaveBeenCalledWith({
      issueId: "issue-id",
      title: "Changed",
      assigneeId: null,
    });
    await gateway.createComment({ issueId: "ENG-1", body: "Hello" });
    expect(fakeApi.createComment).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      issueId: "issue-id",
      body: "Hello",
    });
  });

  it("rejects cross-team workflow states before writing", async () => {
    const fakeApi = api();
    fakeApi.resources.mockImplementation(async ({ type }: ResourcePageInput) => ({
      nodes:
        type === "teams"
          ? [{ type: "teams", id: "team-platform", name: "Platform", key: "PLAT" }]
          : type === "states"
            ? [{ type: "states", id: "state-other", name: "Done", teamId: "team-other" }]
            : [],
      hasMore: false,
    }));
    const gateway = new LinearGateway(
      () => credentials(),
      () => fakeApi,
    );
    await expect(
      gateway.createIssue({ team: "PLAT", title: "New", state: "Done" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(fakeApi.createIssue).not.toHaveBeenCalled();
    await expect(gateway.updateIssue({ issueId: "ENG-1", state: "Done" })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(fakeApi.updateIssue).not.toHaveBeenCalled();
  });

  it("does not retrieve credentials or access the API for a write without a configured key", async () => {
    const source = credentials();
    source.has.mockReturnValue(false);
    const createApi = vi.fn(() => api());
    const gateway = new LinearGateway(() => source, createApi);
    await expect(gateway.createComment({ issueId: "ENG-1", body: "Hello" })).rejects.toMatchObject({
      code: CredentialErrorCode.NotConfigured,
    });
    expect(source.use).not.toHaveBeenCalled();
    expect(createApi).not.toHaveBeenCalled();
  });

  it("forwards cursors and resolves human filters through the adapter port", async () => {
    const source = credentials();
    const fakeApi = api();
    const gateway = new LinearGateway(
      () => source,
      () => fakeApi,
    );

    await gateway.listIssues({
      limit: 10,
      cursor: "page-1",
      team: "PLAT",
      assignee: "agent@example.com",
    });

    expect(fakeApi.listIssues).toHaveBeenCalledWith({
      limit: 10,
      cursor: "page-1",
      includeArchived: undefined,
      teamId: "team-platform",
      assigneeId: "user-agent",
    });
  });
});
