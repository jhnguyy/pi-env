import { defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  CommentSummary,
  CreateCommentInput,
  CreateIssueInput,
  IssueListResult,
  IssueSummary,
  LinearGateway,
  ListIssuesInput,
  SearchIssuesInput,
  UpdateIssueInput,
  ViewerSummary,
} from "./client";
import type { LinearAuthContext } from "./auth";

export interface LinearOperations {
  viewer(ctx: LinearAuthContext, signal?: AbortSignal): Promise<ViewerSummary>;
  listIssues(
    input: ListIssuesInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueListResult>;
  searchIssues(
    input: SearchIssuesInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueListResult>;
  issue(issueId: string, ctx: LinearAuthContext, signal?: AbortSignal): Promise<IssueSummary>;
  createIssue(
    input: CreateIssueInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary>;
  updateIssue(
    input: UpdateIssueInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary>;
  createComment(
    input: CreateCommentInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<CommentSummary>;
}

const MAX_ISSUES = 50;
const DEFAULT_ISSUES = 20;

function resultText(value: unknown): string {
  return truncateHead(JSON.stringify(value, null, 2)).content;
}

function boundedIssueList(result: IssueListResult, limit: number): IssueListResult {
  return { ...result, issues: result.issues.slice(0, Math.min(limit, MAX_ISSUES)) };
}

function conciseIssue(issue: IssueSummary): Omit<IssueSummary, "description"> {
  const { description: _description, ...summary } = issue;
  return summary;
}

function conciseComment(comment: CommentSummary): CommentSummary {
  return {
    id: comment.id,
    ...(comment.issueId ? { issueId: comment.issueId } : {}),
    createdAt: comment.createdAt,
    url: comment.url,
  };
}

function issueListText(result: IssueListResult): string {
  const header =
    result.totalCount === undefined
      ? `${result.issues.length} issue(s)${result.hasMore ? "; more results are available" : ""}`
      : `${result.issues.length} of ${result.totalCount} matching issue(s)${result.hasMore ? "; more results are available" : ""}`;
  const lines = result.issues.map((issue) => {
    const state = issue.state?.name ?? "unknown state";
    const assignee = issue.assignee?.name ? `, ${issue.assignee.name}` : "";
    return `${issue.identifier} [${issue.priorityLabel}] ${issue.title} (${state}${assignee})\n${issue.url}`;
  });
  return truncateHead([header, ...lines].join("\n")).content;
}

function toolResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createLinearTools(gateway: LinearOperations | LinearGateway): ToolDefinition[] {
  return [
    defineTool({
      name: "linear_viewer",
      label: "Linear Viewer",
      description:
        "Get the authenticated Linear user and workspace. Starts OAuth login when needed in an interactive session.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        const viewer = await gateway.viewer(ctx, signal);
        return toolResult(resultText(viewer), viewer);
      },
    }),
    defineTool({
      name: "linear_list_issues",
      label: "List Linear Issues",
      description:
        "List up to 50 Linear issues, with optional team, assignee, and archive filters. Output is bounded.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_ISSUES,
            description: `Maximum issues to return. Default: ${DEFAULT_ISSUES}.`,
          }),
        ),
        teamId: Type.Optional(Type.String({ description: "Team UUID." })),
        assigneeId: Type.Optional(Type.String({ description: "Assignee UUID." })),
        includeArchived: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const limit = params.limit ?? DEFAULT_ISSUES;
        const issues = boundedIssueList(
          await gateway.listIssues(
            {
              limit,
              teamId: params.teamId,
              assigneeId: params.assigneeId,
              includeArchived: params.includeArchived,
            },
            ctx,
            signal,
          ),
          limit,
        );
        return toolResult(issueListText(issues), issues);
      },
    }),
    defineTool({
      name: "linear_search_issues",
      label: "Search Linear Issues",
      description:
        "Search Linear issues by text and return up to 50 concise results. Output is bounded.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Full-text or semantic issue query." }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_ISSUES,
            description: `Maximum issues to return. Default: ${DEFAULT_ISSUES}.`,
          }),
        ),
        teamId: Type.Optional(Type.String({ description: "Team UUID." })),
        includeArchived: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const limit = params.limit ?? DEFAULT_ISSUES;
        const issues = boundedIssueList(
          await gateway.searchIssues(
            {
              query: params.query,
              limit,
              teamId: params.teamId,
              includeArchived: params.includeArchived,
            },
            ctx,
            signal,
          ),
          limit,
        );
        return toolResult(issueListText(issues), issues);
      },
    }),
    defineTool({
      name: "linear_get_issue",
      label: "Get Linear Issue",
      description:
        "Get one Linear issue by UUID or human-readable identifier, including its bounded description.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue UUID or identifier such as ENG-123." }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const issue = await gateway.issue(params.issueId, ctx, signal);
        return toolResult(resultText(issue), issue);
      },
    }),
    defineTool({
      name: "linear_create_issue",
      label: "Create Linear Issue",
      description:
        "Create a Linear issue and return concise issue data. Requires a team UUID and OAuth write access.",
      parameters: Type.Object({
        teamId: Type.String({ description: "Team UUID." }),
        title: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String({ description: "Markdown issue description." })),
        assigneeId: Type.Optional(Type.String()),
        stateId: Type.Optional(Type.String()),
        projectId: Type.Optional(Type.String()),
        priority: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 4,
            description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
          }),
        ),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format." })),
        labelIds: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const issue = conciseIssue(await gateway.createIssue(params, ctx, signal));
        return toolResult(resultText(issue), issue);
      },
    }),
    defineTool({
      name: "linear_update_issue",
      label: "Update Linear Issue",
      description:
        "Update one Linear issue and return concise issue data. Supply at least one field to change.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue UUID or identifier such as ENG-123." }),
        title: Type.Optional(Type.String({ minLength: 1 })),
        description: Type.Optional(Type.String({ description: "Markdown issue description." })),
        assigneeId: Type.Optional(Type.String()),
        stateId: Type.Optional(Type.String()),
        projectId: Type.Optional(Type.String()),
        priority: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 4,
            description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
          }),
        ),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format." })),
        labelIds: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (Object.keys(params).every((key) => key === "issueId")) {
          throw new Error("linear_update_issue requires at least one field to update.");
        }
        const issue = conciseIssue(await gateway.updateIssue(params, ctx, signal));
        return toolResult(resultText(issue), issue);
      },
    }),
    defineTool({
      name: "linear_create_comment",
      label: "Create Linear Comment",
      description: "Create a Markdown comment on a Linear issue and return concise comment data.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue UUID or identifier such as ENG-123." }),
        body: Type.String({ minLength: 1, description: "Markdown comment body." }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const comment = conciseComment(await gateway.createComment(params, ctx, signal));
        return toolResult(resultText(comment), comment);
      },
    }),
  ];
}
