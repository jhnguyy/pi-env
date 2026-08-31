import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CursorPage, IssueSummary, LinearResourceSummary } from "./api";
import type { LinearGateway } from "./client";
import { asLinearError, throwToolError } from "./domain";

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;

function resultText(value: unknown): string {
  return truncateHead(JSON.stringify(value, null, 2)).content;
}

function boundedPage<T>(result: CursorPage<T>, limit: number): CursorPage<T> {
  return { ...result, nodes: result.nodes.slice(0, Math.min(limit, MAX_RESULTS)) };
}

function issuePageText(result: CursorPage<IssueSummary>): string {
  const count =
    result.totalCount === undefined
      ? `${result.nodes.length} issue(s)`
      : `${result.nodes.length} of ${result.totalCount} matching issue(s)`;
  const header = `${count}${result.hasMore ? "; use endCursor to continue" : ""}`;
  const lines = result.nodes.map((issue) => {
    const state = issue.state?.name ?? "unknown state";
    const assignee = issue.assignee?.name ? `, ${issue.assignee.name}` : "";
    return `${issue.identifier} [${issue.priorityLabel}] ${issue.title} (${state}${assignee})\n${issue.url}`;
  });
  return truncateHead([header, ...lines].join("\n")).content;
}

function resourcePageText(result: CursorPage<LinearResourceSummary>): string {
  const lines = result.nodes.map((item) =>
    [item.type, item.name, item.key, item.email, item.id].filter(Boolean).join(" | "),
  );
  return truncateHead(
    [
      `${result.nodes.length} resource(s)${result.hasMore ? "; use endCursor to continue" : ""}`,
      ...lines,
    ].join("\n"),
  ).content;
}

function toolResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

async function executeTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throwToolError(asLinearError(error));
  }
}

export function createLinearTools(gateway: LinearGateway): ToolDefinition[] {
  return [
    defineTool({
      name: "linear_viewer",
      label: "Linear Viewer",
      description: "Get the Linear user and workspace for the configured API key.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        return executeTool(async () => {
          const viewer = await gateway.viewer(signal);
          return toolResult(resultText(viewer), viewer);
        });
      },
    }),
    defineTool({
      name: "linear_list_resources",
      label: "List Linear Resources",
      description:
        "Discover Linear teams, users, workflow states, projects, or labels by human name, key, email, or UUID. Supports cursor pagination.",
      parameters: Type.Object({
        type: StringEnum(["teams", "users", "states", "projects", "labels"] as const),
        query: Type.Optional(
          Type.String({ description: "Optional local name, key, email, or UUID filter." }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
        cursor: Type.Optional(Type.String({ description: "endCursor from the previous page." })),
      }),
      async execute(_id, params, signal) {
        return executeTool(async () => {
          const limit = params.limit ?? DEFAULT_RESULTS;
          const resources = boundedPage(
            await gateway.listResources(
              { type: params.type, query: params.query, limit, cursor: params.cursor },
              signal,
            ),
            limit,
          );
          return toolResult(resourcePageText(resources), resources);
        });
      },
    }),
    defineTool({
      name: "linear_list_issues",
      label: "List Linear Issues",
      description:
        "List up to 50 Linear issues. Team and assignee accept names, keys, emails, or UUIDs. Supports cursor pagination.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
        cursor: Type.Optional(Type.String({ description: "endCursor from the previous page." })),
        team: Type.Optional(Type.String({ description: "Team name, key, or UUID." })),
        assignee: Type.Optional(Type.String({ description: "Assignee name, email, or UUID." })),
        includeArchived: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal) {
        return executeTool(async () => {
          const limit = params.limit ?? DEFAULT_RESULTS;
          const issues = boundedPage(
            await gateway.listIssues(
              {
                limit,
                cursor: params.cursor,
                team: params.team,
                assignee: params.assignee,
                includeArchived: params.includeArchived,
              },
              signal,
            ),
            limit,
          );
          return toolResult(issuePageText(issues), issues);
        });
      },
    }),
    defineTool({
      name: "linear_search_issues",
      label: "Search Linear Issues",
      description:
        "Search Linear issues by text. Team and assignee accept names, keys, emails, or UUIDs. Supports cursor pagination.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
        cursor: Type.Optional(Type.String({ description: "endCursor from the previous page." })),
        team: Type.Optional(Type.String({ description: "Team name, key, or UUID." })),
        assignee: Type.Optional(Type.String({ description: "Assignee name, email, or UUID." })),
        includeArchived: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal) {
        return executeTool(async () => {
          const limit = params.limit ?? DEFAULT_RESULTS;
          const issues = boundedPage(
            await gateway.searchIssues(
              {
                query: params.query,
                limit,
                cursor: params.cursor,
                team: params.team,
                assignee: params.assignee,
                includeArchived: params.includeArchived,
              },
              signal,
            ),
            limit,
          );
          return toolResult(issuePageText(issues), issues);
        });
      },
    }),
    defineTool({
      name: "linear_get_issue",
      label: "Get Linear Issue",
      description:
        "Get one Linear issue by UUID or human-readable identifier, including a bounded description.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue UUID or identifier such as ENG-123." }),
      }),
      async execute(_id, params, signal) {
        return executeTool(async () => {
          const issue = await gateway.issue(params.issueId, signal);
          return toolResult(resultText(issue), issue);
        });
      },
    }),
  ];
}
