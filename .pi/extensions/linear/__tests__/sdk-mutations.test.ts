import { LinearClient } from "@linear/sdk";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LinearSdkApi } from "../sdk-adapter";

const issue = {
  id: "issue-id",
  identifier: "ENG-1",
  title: "Ticket",
  description: "Description",
  priority: 3,
  priorityLabel: "Medium",
  teamId: "team-id",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  url: "https://linear.app/example/issue/ENG-1",
  state: Promise.resolve(null),
  assignee: Promise.resolve(null),
};
const comment = {
  id: "comment-id",
  issueId: "issue-id",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  url: "https://linear.app/example/issue/ENG-1#comment-id",
};

describeIfEnabled("linear", "Linear SDK mutation contract", () => {
  it("passes stable IDs and patch values to SDK mutations and summarizes their results", async () => {
    const sdk = Object.assign(Object.create(LinearClient.prototype) as LinearClient, {
      createIssue: vi.fn(async () => ({ success: true, issue: Promise.resolve(issue) })),
      updateIssue: vi.fn(async () => ({ success: true, issue: Promise.resolve(issue) })),
      createComment: vi.fn(async () => ({ success: true, comment: Promise.resolve(comment) })),
    });
    const api = new LinearSdkApi("test-token", undefined, () => sdk);
    expect(
      await api.createIssue({ id: "stable-issue-id", teamId: "team-id", title: "Ticket" }),
    ).toMatchObject({ id: "issue-id", identifier: "ENG-1" });
    expect(sdk.createIssue).toHaveBeenCalledWith({
      id: "stable-issue-id",
      teamId: "team-id",
      title: "Ticket",
    });
    expect(
      await api.updateIssue({ issueId: "issue-id", description: "Updated", assigneeId: null }),
    ).toMatchObject({ id: "issue-id" });
    expect(sdk.updateIssue).toHaveBeenCalledWith("issue-id", {
      description: "Updated",
      assigneeId: null,
    });
    expect(
      await api.createComment({ id: "stable-comment-id", issueId: "issue-id", body: "Hello" }),
    ).toMatchObject({ id: "comment-id", issueId: "issue-id" });
    expect(sdk.createComment).toHaveBeenCalledWith({
      id: "stable-comment-id",
      issueId: "issue-id",
      body: "Hello",
    });
  });

  it("recovers created items by client-generated ID when the create response is lost", async () => {
    const sdk = Object.assign(Object.create(LinearClient.prototype) as LinearClient, {
      createIssue: vi.fn(async () => {
        throw new Error("response lost");
      }),
      issue: vi.fn(async () => issue),
      createComment: vi.fn(async () => {
        throw new Error("response lost");
      }),
      comment: vi.fn(async () => comment),
    });
    const api = new LinearSdkApi("test-token", undefined, () => sdk);
    await expect(
      api.createIssue({ id: "stable-issue-id", teamId: "team-id", title: "Ticket" }),
    ).resolves.toMatchObject({ id: "issue-id" });
    expect(sdk.issue).toHaveBeenCalledWith("stable-issue-id");
    await expect(
      api.createComment({ id: "stable-comment-id", issueId: "issue-id", body: "Hello" }),
    ).resolves.toMatchObject({ id: "comment-id" });
    expect(sdk.comment).toHaveBeenCalledWith({ id: "stable-comment-id" });
  });
});
