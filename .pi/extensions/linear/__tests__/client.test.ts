import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { CredentialSource } from "../../_shared/credential-source";
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

function credentials(): CredentialSource & { use: ReturnType<typeof vi.fn> } {
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
    createIssue: vi.fn(async (_input: CreateIssueApiInput) => {
      throw new Error("read-only test");
    }),
    updateIssue: vi.fn(async (_input: UpdateIssueApiInput) => {
      throw new Error("read-only test");
    }),
    createComment: vi.fn(async (_input: CreateCommentApiInput) => {
      throw new Error("read-only test");
    }),
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
    expect(source.use).toHaveBeenCalledWith(
      { name: "linear.apiKey", consumer: "linear" },
      expect.any(Function),
      undefined,
    );
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
