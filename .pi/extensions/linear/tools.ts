import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CursorPage, IssueSummary, LinearResourceSummary } from "./api";
import type { LinearGateway } from "./client";
import { asLinearError, LinearErrorCode, linearError, throwToolError } from "./domain";
import type { PublicPiToolUi, ToolContract } from "../_shared/tool-contract";
import { renderCompactToolCall, renderTextToolResult } from "../_shared/tool-render";

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;

export const LinearAction = {
  Viewer: "viewer",
  ListResources: "list-resources",
  ListIssues: "list-issues",
  SearchIssues: "search-issues",
  GetIssue: "get-issue",
  Read: "read",
  List: "list",
  Search: "search",
  Create: "create",
  Update: "update",
} as const;
export type LinearAction = (typeof LinearAction)[keyof typeof LinearAction];

const LINEAR_ACTIONS = Object.values(LinearAction) as [LinearAction, ...LinearAction[]];
const LinearParameters = Type.Object(
  {
    collection: Type.Optional(
      StringEnum(["viewer", "resources", "issues", "comments"] as const, {
        description:
          "Linear resource collection. Required for collection actions; omit for legacy read actions.",
      }),
    ),
    action: StringEnum(LINEAR_ACTIONS, {
      description: "Operation on the selected collection.",
    }),
    resourceType: Type.Optional(
      StringEnum(["teams", "users", "states", "projects", "labels"] as const, {
        description: "Resource type. Required for resources/list (or legacy list-resources).",
      }),
    ),
    query: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Resource filter or issue search text. Required for issues/search.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
    cursor: Type.Optional(Type.String({ description: "endCursor from the previous page." })),
    team: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256, description: "Team name, key, or UUID." }),
    ),
    assignee: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()], {
        description: "Assignee name, email, or UUID; null clears it on update.",
      }),
    ),
    includeArchived: Type.Optional(Type.Boolean()),
    issueId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256, description: "Issue UUID or identifier." }),
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        description: "Issue title. Required for issues/create.",
      }),
    ),
    description: Type.Optional(Type.String({ maxLength: 100_000 })),
    body: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100_000,
        description: "Comment text. Required for comments/create.",
      }),
    ),
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    project: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    ),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    dueDate: Type.Optional(
      Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]),
    ),
    labels: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 50,
        description: "Full label set; [] clears labels on update.",
      }),
    ),
  },
  { additionalProperties: false },
);
type LinearParameters = Static<typeof LinearParameters>;
type LinearParameterName = Exclude<keyof LinearParameters, "action" | "collection">;
type Operation =
  | "viewer"
  | "list-resources"
  | "list-issues"
  | "search-issues"
  | "get-issue"
  | "create-issue"
  | "update-issue"
  | "create-comment";

const ACTION_PARAMETERS: Record<Operation, readonly LinearParameterName[]> = {
  viewer: [],
  "list-resources": ["resourceType", "query", "limit", "cursor"],
  "list-issues": ["limit", "cursor", "team", "assignee", "includeArchived"],
  "search-issues": ["query", "limit", "cursor", "team", "assignee", "includeArchived"],
  "get-issue": ["issueId"],
  "create-issue": [
    "team",
    "title",
    "description",
    "assignee",
    "state",
    "project",
    "priority",
    "dueDate",
    "labels",
  ],
  "update-issue": [
    "issueId",
    "title",
    "description",
    "assignee",
    "state",
    "project",
    "priority",
    "dueDate",
    "labels",
  ],
  "create-comment": ["issueId", "body"],
};

function operation(params: LinearParameters): Operation {
  if (!params.collection) {
    if (
      ["viewer", "list-resources", "list-issues", "search-issues", "get-issue"].includes(
        params.action,
      )
    )
      return params.action as Operation;
  } else {
    const mapped: Partial<
      Record<NonNullable<LinearParameters["collection"]>, Partial<Record<LinearAction, Operation>>>
    > = {
      viewer: { read: "viewer" },
      resources: { list: "list-resources" },
      issues: {
        list: "list-issues",
        search: "search-issues",
        read: "get-issue",
        create: "create-issue",
        update: "update-issue",
      },
      comments: { create: "create-comment" },
    };
    const result = mapped[params.collection]?.[params.action];
    if (result) return result;
  }
  throw linearError(
    LinearErrorCode.Validation,
    "Invalid Linear collection and action combination.",
  );
}

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

function validateParameters(params: LinearParameters, selected: Operation): void {
  const allowed = new Set<LinearParameterName>(ACTION_PARAMETERS[selected]);
  const unexpected = (Object.keys(params) as Array<keyof LinearParameters>).filter(
    (name): name is LinearParameterName =>
      name !== "action" &&
      name !== "collection" &&
      params[name] !== undefined &&
      !allowed.has(name),
  );
  if (unexpected.length > 0) {
    throw linearError(
      LinearErrorCode.Validation,
      `Parameter ${unexpected.join(", ")} is not valid for Linear action ${params.action}.`,
      { details: { action: params.action, parameters: unexpected } },
    );
  }
  validateRequiredFields(params, selected);
}

function validateRequiredFields(params: LinearParameters, selected: Operation): void {
  if (selected === "list-resources" && !params.resourceType) {
    throw linearError(LinearErrorCode.Validation, "resourceType is required for list-resources.");
  }
  if (selected === "search-issues" && !params.query?.trim()) {
    throw linearError(LinearErrorCode.Validation, "query is required for search-issues.");
  }
  if (
    ["get-issue", "update-issue", "create-comment"].includes(selected) &&
    !params.issueId?.trim()
  ) {
    throw linearError(LinearErrorCode.Validation, "issueId is required.");
  }
  if (selected === "create-issue" && (!params.team?.trim() || !params.title?.trim())) {
    throw linearError(
      LinearErrorCode.Validation,
      "team and title are required for issue creation.",
    );
  }
  if (selected === "create-comment" && !params.body?.trim()) {
    throw linearError(LinearErrorCode.Validation, "body is required for comment creation.");
  }
  validateWriteFields(params, selected);
}

function validateWriteFields(params: LinearParameters, selected: Operation): void {
  if (selected !== "update-issue" && params.assignee === null) {
    throw linearError(LinearErrorCode.Validation, "Only issue updates can clear assignee.");
  }
  if (
    selected === "create-issue" &&
    (params.project === null || params.dueDate === null || params.assignee === null)
  ) {
    throw linearError(
      LinearErrorCode.Validation,
      "Null references are only valid for issue updates.",
    );
  }
  if (
    selected === "update-issue" &&
    !ACTION_PARAMETERS[selected].some((name) => name !== "issueId" && params[name] !== undefined)
  ) {
    throw linearError(
      LinearErrorCode.Validation,
      "At least one change is required for issue update.",
    );
  }
  if (
    ["create-issue", "update-issue"].includes(selected) &&
    params.title !== undefined &&
    !params.title.trim()
  ) {
    throw linearError(LinearErrorCode.Validation, "title cannot be blank.");
  }
  validateDateAndReferences(params);
}

function validateDateAndReferences(params: LinearParameters): void {
  if (
    params.dueDate &&
    (Number.isNaN(Date.parse(`${params.dueDate}T00:00:00Z`)) ||
      new Date(`${params.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== params.dueDate)
  ) {
    throw linearError(LinearErrorCode.Validation, "dueDate must be a valid ISO date.");
  }
  if (
    [params.team, params.state, ...(params.labels ?? [])].some(
      (value) => value !== undefined && !value.trim(),
    )
  ) {
    throw linearError(LinearErrorCode.Validation, "Resource references cannot be blank.");
  }
}

export type LinearToolGateway = Pick<
  LinearGateway,
  | "viewer"
  | "listResources"
  | "listIssues"
  | "searchIssues"
  | "issue"
  | "createIssue"
  | "updateIssue"
  | "createComment"
>;

function definedFields<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

async function dispatchLinear(
  gateway: LinearToolGateway,
  params: LinearParameters,
  signal?: AbortSignal,
) {
  const selected = operation(params);
  validateParameters(params, selected);
  if (["create-issue", "update-issue", "create-comment"].includes(selected)) {
    return dispatchWrite(gateway, params, selected, signal);
  }
  return dispatchRead(gateway, params, selected, signal);
}

async function dispatchRead(
  gateway: LinearToolGateway,
  params: LinearParameters,
  selected: Operation,
  signal?: AbortSignal,
) {
  const limit = params.limit ?? DEFAULT_RESULTS;
  switch (selected) {
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
            assignee: params.assignee ?? undefined,
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
            assignee: params.assignee ?? undefined,
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
  throw linearError(LinearErrorCode.Validation, "Invalid Linear read action.");
}

async function dispatchWrite(
  gateway: LinearToolGateway,
  params: LinearParameters,
  selected: Operation,
  signal?: AbortSignal,
) {
  switch (selected) {
    case "create-issue": {
      const issue = await gateway.createIssue(
        definedFields({
          team: params.team!,
          title: params.title!,
          description: params.description,
          assignee: params.assignee ?? undefined,
          state: params.state,
          project: params.project ?? undefined,
          priority: params.priority,
          dueDate: params.dueDate ?? undefined,
          labels: params.labels,
        }),
        signal,
      );
      return toolResult(resultText(issue), issue);
    }
    case "update-issue": {
      const issue = await gateway.updateIssue(
        definedFields({
          issueId: params.issueId!,
          title: params.title,
          description: params.description,
          assignee: params.assignee,
          state: params.state,
          project: params.project,
          priority: params.priority,
          dueDate: params.dueDate,
          labels: params.labels,
        }),
        signal,
      );
      return toolResult(resultText(issue), issue);
    }
    case "create-comment": {
      const comment = await gateway.createComment(
        { issueId: params.issueId!, body: params.body! },
        signal,
      );
      return toolResult(resultText(comment), comment);
    }
  }
  throw linearError(LinearErrorCode.Validation, "Invalid Linear write action.");
}

export function createLinearContract(
  gateway: LinearToolGateway,
): ToolContract<LinearParameters, unknown, typeof LinearParameters> {
  return {
    name: "linear",
    label: "Linear",
    description:
      "Read and write Linear issues and comments. Select a collection (viewer, resources, issues, comments) and action (read, list, search, create, update). Mutations change Linear tickets. Legacy read actions remain available without a collection. List operations support bounded cursor pagination.",
    parameters: LinearParameters,
    async execute(params, context) {
      return executeTool(() => dispatchLinear(gateway, params, context.signal));
    },
  };
}

export const linearPiOptions: PublicPiToolUi<typeof LinearParameters, unknown> = {
  renderCall: (params, theme) =>
    renderCompactToolCall(
      "linear",
      [params.collection, params.action, params.issueId, params.query].filter(Boolean).join(" "),
      theme,
    ),
  renderResult: (result, options, theme, context) =>
    renderTextToolResult("linear", result, options, theme, context),
};
