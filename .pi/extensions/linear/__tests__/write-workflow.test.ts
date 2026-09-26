import { LinearClient } from "@linear/sdk";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import type { CredentialSource } from "../../_shared/credential-source";
import { LinearGateway } from "../client";
import { LinearSdkApi } from "../sdk-adapter";
import { createLinearContract } from "../tools";

// Exercise the public tool contract through the credential gateway and SDK adapter.
// The SDK transport is stubbed so the test cannot change a real Linear workspace.
describeIfEnabled("linear", "Linear write workflow", () => {
  it("creates a ticket, edits it, and comments on it", async () => {
    const issue = {
      id: "issue-id",
      identifier: "ENG-1",
      title: "New ticket",
      description: "",
      priority: 0,
      priorityLabel: "No priority",
      teamId: "team-id",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      url: "https://linear.app/example/issue/ENG-1",
      state: Promise.resolve(null),
      assignee: Promise.resolve(null),
    };
    const sdk = Object.assign(Object.create(LinearClient.prototype) as LinearClient, {
      teams: vi.fn(async () => ({
        nodes: [{ id: "team-id", name: "Engineering", key: "ENG" }],
        pageInfo: { hasNextPage: false },
      })),
      issue: vi.fn(async () => issue),
      createIssue: vi.fn(async () => ({ success: true, issue: Promise.resolve(issue) })),
      updateIssue: vi.fn(async () => ({ success: true, issue: Promise.resolve(issue) })),
      createComment: vi.fn(async () => ({
        success: true,
        comment: Promise.resolve({
          id: "comment-id",
          issueId: "issue-id",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          url: "https://linear.app/example/issue/ENG-1#comment-id",
        }),
      })),
    });
    const source: CredentialSource = {
      has: () => true,
      use: async (_request, consume) => consume("test-only-token"),
    };
    const gateway = new LinearGateway(
      () => source,
      (key, signal) => new LinearSdkApi(key, signal, () => sdk),
    );
    const tool = createLinearContract(gateway);
    const context = { cwd: "/repo" };

    const created = await tool.execute(
      { collection: "issues", action: "create", team: "ENG", title: "New ticket" },
      context,
    );
    expect(created.details).toMatchObject({ id: "issue-id", identifier: "ENG-1" });
    expect(sdk.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), teamId: "team-id", title: "New ticket" }),
    );

    const edited = await tool.execute(
      { collection: "issues", action: "update", issueId: "ENG-1", description: "Updated" },
      context,
    );
    expect(edited.details).toMatchObject({ id: "issue-id" });
    expect(sdk.updateIssue).toHaveBeenCalledWith("issue-id", { description: "Updated" });

    const commented = await tool.execute(
      { collection: "comments", action: "create", issueId: "ENG-1", body: "Follow-up" },
      context,
    );
    expect(commented.details).toMatchObject({ id: "comment-id", issueId: "issue-id" });
    expect(sdk.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), issueId: "issue-id", body: "Follow-up" }),
    );
  });
});
