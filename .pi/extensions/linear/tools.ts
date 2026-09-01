import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CursorPage, IssueSummary, LinearResourceSummary } from "./api";
import type { LinearGateway } from "./client";
import { asLinearError, LinearErrorCode, linearError, throwToolError } from "./domain";

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;

export const LinearAction = {
  Viewer: "viewer",
  ListResources: "list-resources",
  ListIssues: "list-issues",
  SearchIssues: "search-issues",
  GetIssue: "get-issue",
} as const;
export type LinearAction = (typeof LinearAction)[keyof typeof LinearAction];

const LINEAR_ACTIONS = Object.values(LinearAction) as [LinearAction, ...LinearAction[]];
const LinearParameters = Type.Object(
  {
    action: StringEnum(LINEAR_ACTIONS, {
      description: "Linear operation to perform.",
    }),
    resourceType: Type.Optional(
      StringEnum(["teams", "users", "states", "projects", "labels"] as const, {
        description: "Resource type. Required for action=list-resources.",
      }),
    ),
    query: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Resource filter or issue search text. Required for action=search-issues.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
    cursor: Type.Optional(Type.String({ description: "endCursor from the previous page." })),
    team: Type.Optional(Type.String({ description: "Team name, key, or UUID." })),
    assignee: Type.Optional(Type.String({ description: "Assignee name, email, or UUID." })),
    includeArchived: Type.Optional(Type.Boolean()),
    issueId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Issue UUID or identifier. Required for action=get-issue.",
      }),
    ),
  },
  { additionalProperties: false },
);
type LinearParameters = Static<typeof LinearParameters>;
type LinearParameterName = Exclude<keyof LinearParameters, "action">;

const ACTION_PARAMETERS: Record<LinearAction, readonly LinearParameterName[]> = {
  [LinearAction.Viewer]: [],
  [LinearAction.ListResources]: ["resourceType", "query", "limit", "cursor"],
  [LinearAction.ListIssues]: ["limit", "cursor", "team", "assignee", "includeArchived"],
  [LinearAction.SearchIssues]: ["query", "limit", "cursor", "team", "assignee", "includeArchived"],
  [LinearAction.GetIssue]: ["issueId"],
};

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

function validateParameters(params: LinearParameters): void {
  const allowed = new Set<LinearParameterName>(ACTION_PARAMETERS[params.action]);
  const unexpected = (Object.keys(params) as Array<keyof LinearParameters>).filter(
    (name): name is LinearParameterName =>
      name !== "action" && params[name] !== undefined && !allowed.has(name),
  );
  if (unexpected.length > 0) {
    throw linearError(
      LinearErrorCode.Validation,
      `Parameter ${unexpected.join(", ")} is not valid for Linear action ${params.action}.`,
      { details: { action: params.action, parameters: unexpected } },
    );
  }
  if (params.action === LinearAction.ListResources && !params.resourceType) {
    throw linearError(LinearErrorCode.Validation, "resourceType is required for list-resources.");
  }
  if (params.action === LinearAction.SearchIssues && !params.query) {
    throw linearError(LinearErrorCode.Validation, "query is required for search-issues.");
  }
  if (params.action === LinearAction.GetIssue && !params.issueId) {
    throw linearError(LinearErrorCode.Validation, "issueId is required for get-issue.");
  }
}

async function dispatchLinear(
  gateway: LinearGateway,
  params: LinearParameters,
  signal?: AbortSignal,
) {
  validateParameters(params);
  const limit = params.limit ?? DEFAULT_RESULTS;

  switch (params.action) {
    case LinearAction.Viewer: {
      const viewer = await gateway.viewer(signal);
      return toolResult(resultText(viewer), viewer);
    }
    case LinearAction.ListResources: {
      const resources = boundedPage(
        await gateway.listResources(
          {
            type: params.resourceType!,
            query: params.query,
            limit,
            cursor: params.cursor,
          },
          signal,
        ),
        limit,
      );
      return toolResult(resourcePageText(resources), resources);
    }
    case LinearAction.ListIssues: {
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
    }
    case LinearAction.SearchIssues: {
      const issues = boundedPage(
        await gateway.searchIssues(
          {
            query: params.query!,
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
    }
    case LinearAction.GetIssue: {
      const issue = await gateway.issue(params.issueId!, signal);
      return toolResult(resultText(issue), issue);
    }
  }
}

export function createLinearTool(gateway: LinearGateway): ToolDefinition {
  return defineTool<typeof LinearParameters, unknown>({
    name: "linear",
    label: "Linear",
    description:
      "Read Linear viewer, resource, and issue data. Use the action parameter to select an operation. List operations support bounded cursor pagination.",
    parameters: LinearParameters,
    async execute(_id, params, signal) {
      return executeTool(() => dispatchLinear(gateway, params, signal));
    },
  });
}
