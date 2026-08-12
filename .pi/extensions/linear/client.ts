import { createHash } from "node:crypto";
import type {
  CommentSummary,
  CreateCommentApiInput,
  CreateIssueApiInput,
  CursorPage,
  IssueSummary,
  LinearApi,
  LinearApiFactory,
  LinearResourceSummary,
  LinearResourceType,
  UpdateIssueApiInput,
  ViewerSummary,
} from "./api";
import type { LinearAuthAccess } from "./auth";
import { LinearErrorCode, LinearExtensionError, linearError } from "./domain";
import type { LinearSelectionContext } from "./selection";
import type { LinearConnectionConfig } from "./storage";

export interface ListIssuesInput {
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
  team?: string;
  assignee?: string;
}

export interface SearchIssuesInput extends ListIssuesInput {
  query: string;
}

export interface ListResourcesInput {
  type: LinearResourceType;
  limit: number;
  cursor?: string;
  query?: string;
}

export interface CreateIssueInput {
  operationKey: string;
  team: string;
  title: string;
  description?: string;
  assignee?: string;
  state?: string;
  project?: string;
  priority?: number;
  dueDate?: string;
  labels?: string[];
}

export interface UpdateIssueInput {
  issueId: string;
  title?: string;
  description?: string;
  assignee?: string;
  clearAssignee?: boolean;
  state?: string;
  project?: string;
  clearProject?: boolean;
  priority?: number;
  dueDate?: string;
  clearDueDate?: boolean;
  labels?: string[];
  clearLabels?: boolean;
}

export interface CreateCommentInput {
  operationKey: string;
  issueId: string;
  body: string;
}

export interface PreparedLinearWrite<T> {
  expectedConnectionId: string;
  input: T;
  preview: Record<string, unknown>;
}

function deterministicUuid(input: string): string {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableOperationId(operation: string, key: string, payload: unknown): string {
  return deterministicUuid(`${operation}:${key}:${JSON.stringify(payload)}`);
}

function encodeResourceSearchCursor(
  type: LinearResourceType,
  query: string,
  offset: number,
): string {
  return `linear-resource:${Buffer.from(JSON.stringify({ type, query, offset })).toString("base64url")}`;
}

function decodeResourceSearchCursor(
  cursor: string | undefined,
  type: LinearResourceType,
  query: string,
): number {
  if (!cursor) return 0;
  try {
    if (!cursor.startsWith("linear-resource:")) throw new Error("wrong cursor type");
    const decoded = JSON.parse(
      Buffer.from(cursor.slice("linear-resource:".length), "base64url").toString("utf8"),
    ) as { type?: unknown; query?: unknown; offset?: unknown };
    if (
      decoded.type !== type ||
      decoded.query !== query ||
      !Number.isInteger(decoded.offset) ||
      (decoded.offset as number) < 0
    ) {
      throw new Error("cursor does not match query");
    }
    return decoded.offset as number;
  } catch (cause) {
    throw linearError(LinearErrorCode.Validation, "The Linear resource search cursor is invalid.", {
      recovery: "Use endCursor from the previous identical linear_list_resources query.",
      cause,
    });
  }
}

function connectionPreview(connection: LinearConnectionConfig) {
  return {
    id: connection.id,
    name: connection.name,
    workspace: connection.organization.name,
    workspaceKey: connection.organization.urlKey,
    user: connection.viewer.email,
  };
}

export function validateUpdateInput(input: UpdateIssueInput): void {
  const changed = Object.keys(input).filter((key) => key !== "issueId");
  if (!changed.length) {
    throw linearError(
      LinearErrorCode.Validation,
      "linear_update_issue requires at least one field to update.",
    );
  }
  for (const [valueField, clearField] of [
    ["assignee", "clearAssignee"],
    ["project", "clearProject"],
    ["dueDate", "clearDueDate"],
    ["labels", "clearLabels"],
  ] as const) {
    if (input[valueField] !== undefined && input[clearField] === true) {
      throw linearError(
        LinearErrorCode.Validation,
        `${valueField} and ${clearField} cannot be used together.`,
      );
    }
  }
}

export class LinearGateway {
  readonly #auth: LinearAuthAccess;
  readonly #createApi: LinearApiFactory;

  constructor(auth: LinearAuthAccess, createApi: LinearApiFactory) {
    this.#auth = auth;
    this.#createApi = createApi;
  }

  viewer(ctx: LinearSelectionContext, signal?: AbortSignal): Promise<ViewerSummary> {
    return this.#withApi(ctx, "read", signal, (api) => api.viewer());
  }

  listResources(
    input: ListResourcesInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<CursorPage<LinearResourceSummary>> {
    return this.#withApi(ctx, "read", signal, async (api) => {
      if (!input.query?.trim()) {
        return api.resources({ type: input.type, limit: input.limit, cursor: input.cursor });
      }
      const query = input.query.trim().toLowerCase();
      const offset = decodeResourceSearchCursor(input.cursor, input.type, query);
      const resources: LinearResourceSummary[] = [];
      let apiCursor: string | undefined;
      const seen = new Set<string>();
      while (true) {
        const result = await api.resources({ type: input.type, limit: 100, cursor: apiCursor });
        resources.push(...result.nodes);
        if (!result.hasMore) break;
        if (!result.endCursor || seen.has(result.endCursor)) {
          throw linearError(
            LinearErrorCode.Api,
            `Linear ${input.type} pagination did not advance.`,
            { retryable: true },
          );
        }
        seen.add(result.endCursor);
        apiCursor = result.endCursor;
      }
      const matches = resources.filter((item) =>
        [item.id, item.name, item.key, item.email]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(query)),
      );
      const nodes = matches.slice(offset, offset + input.limit);
      const nextOffset = offset + nodes.length;
      const hasMore = nextOffset < matches.length;
      return {
        nodes,
        hasMore,
        ...(hasMore
          ? { endCursor: encodeResourceSearchCursor(input.type, query, nextOffset) }
          : {}),
      };
    });
  }

  listIssues(
    input: ListIssuesInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<CursorPage<IssueSummary>> {
    return this.#withApi(ctx, "read", signal, async (api) => {
      const teamId = input.team
        ? (await this.#resolveResource(api, "teams", input.team)).id
        : undefined;
      const assigneeId = input.assignee
        ? (await this.#resolveResource(api, "users", input.assignee)).id
        : undefined;
      return api.listIssues({
        limit: input.limit,
        cursor: input.cursor,
        includeArchived: input.includeArchived,
        teamId,
        assigneeId,
      });
    });
  }

  searchIssues(
    input: SearchIssuesInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<CursorPage<IssueSummary>> {
    return this.#withApi(ctx, "read", signal, async (api) => {
      const teamId = input.team
        ? (await this.#resolveResource(api, "teams", input.team)).id
        : undefined;
      const assigneeId = input.assignee
        ? (await this.#resolveResource(api, "users", input.assignee)).id
        : undefined;
      return api.searchIssues({
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
        includeArchived: input.includeArchived,
        teamId,
        assigneeId,
      });
    });
  }

  issue(issueId: string, ctx: LinearSelectionContext, signal?: AbortSignal): Promise<IssueSummary> {
    return this.#withApi(ctx, "read", signal, (api) => api.issue(issueId));
  }

  prepareCreateIssue(
    input: CreateIssueInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<PreparedLinearWrite<CreateIssueApiInput>> {
    return this.#withApi(ctx, "write", signal, async (api, connection) => {
      const team = await this.#resolveResource(api, "teams", input.team);
      const [assignee, state, project, labels] = await Promise.all([
        input.assignee ? this.#resolveResource(api, "users", input.assignee) : undefined,
        input.state ? this.#resolveResource(api, "states", input.state, team.id) : undefined,
        input.project ? this.#resolveResource(api, "projects", input.project) : undefined,
        Promise.all(
          (input.labels ?? []).map((label) => this.#resolveResource(api, "labels", label, team.id)),
        ),
      ]);
      const payload = {
        teamId: team.id,
        title: input.title,
        description: input.description,
        assigneeId: assignee?.id,
        stateId: state?.id,
        projectId: project?.id,
        priority: input.priority,
        dueDate: input.dueDate,
        labelIds: labels.map((label) => label.id),
      };
      const apiInput = {
        id: stableOperationId("issue", input.operationKey, payload),
        ...payload,
      };
      return {
        expectedConnectionId: connection.id,
        input: apiInput,
        preview: {
          action: "create_issue",
          connection: connectionPreview(connection),
          issue: {
            id: apiInput.id,
            team,
            title: input.title,
            description: input.description,
            assignee,
            state,
            project,
            priority: input.priority,
            dueDate: input.dueDate,
            labels,
          },
          idempotencyKey: input.operationKey,
        },
      };
    });
  }

  executeCreateIssue(
    prepared: PreparedLinearWrite<CreateIssueApiInput>,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    return this.#withApi(
      ctx,
      "write",
      signal,
      (api) => api.createIssue(prepared.input),
      prepared.expectedConnectionId,
    );
  }

  async prepareUpdateIssue(
    input: UpdateIssueInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<PreparedLinearWrite<UpdateIssueApiInput>> {
    validateUpdateInput(input);
    return this.#withApi(ctx, "write", signal, async (api, connection) => {
      const current = await api.issue(input.issueId);
      const [assignee, state, project, labels] = await Promise.all([
        input.assignee ? this.#resolveResource(api, "users", input.assignee) : undefined,
        input.state ? this.#resolveResource(api, "states", input.state, current.teamId) : undefined,
        input.project ? this.#resolveResource(api, "projects", input.project) : undefined,
        Promise.all(
          (input.labels ?? []).map((label) =>
            this.#resolveResource(api, "labels", label, current.teamId),
          ),
        ),
      ]);
      const apiInput: UpdateIssueApiInput = {
        issueId: input.issueId,
        title: input.title,
        description: input.description,
        ...(input.clearAssignee
          ? { assigneeId: null }
          : assignee
            ? { assigneeId: assignee.id }
            : {}),
        ...(state ? { stateId: state.id } : {}),
        ...(input.clearProject ? { projectId: null } : project ? { projectId: project.id } : {}),
        priority: input.priority,
        ...(input.clearDueDate
          ? { dueDate: null }
          : input.dueDate
            ? { dueDate: input.dueDate }
            : {}),
        ...(input.clearLabels
          ? { labelIds: [] }
          : input.labels
            ? { labelIds: labels.map((label) => label.id) }
            : {}),
      };
      return {
        expectedConnectionId: connection.id,
        input: apiInput,
        preview: {
          action: "update_issue",
          connection: connectionPreview(connection),
          target: {
            id: current.id,
            identifier: current.identifier,
            title: current.title,
            url: current.url,
          },
          changes: {
            title: input.title,
            description: input.description,
            assignee: input.clearAssignee ? null : assignee,
            state,
            project: input.clearProject ? null : project,
            priority: input.priority,
            dueDate: input.clearDueDate ? null : input.dueDate,
            labels: input.clearLabels ? [] : labels,
          },
        },
      };
    });
  }

  executeUpdateIssue(
    prepared: PreparedLinearWrite<UpdateIssueApiInput>,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    return this.#withApi(
      ctx,
      "write",
      signal,
      (api) => api.updateIssue(prepared.input),
      prepared.expectedConnectionId,
    );
  }

  prepareCreateComment(
    input: CreateCommentInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<PreparedLinearWrite<CreateCommentApiInput>> {
    return this.#withApi(ctx, "write", signal, async (api, connection) => {
      const issue = await api.issue(input.issueId);
      const apiInput = {
        id: stableOperationId("comment", input.operationKey, {
          issueId: issue.id,
          body: input.body,
        }),
        issueId: issue.id,
        body: input.body,
      };
      return {
        expectedConnectionId: connection.id,
        input: apiInput,
        preview: {
          action: "create_comment",
          connection: connectionPreview(connection),
          target: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
          },
          body: input.body,
          idempotencyKey: input.operationKey,
          commentId: apiInput.id,
        },
      };
    });
  }

  executeCreateComment(
    prepared: PreparedLinearWrite<CreateCommentApiInput>,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<CommentSummary> {
    return this.#withApi(
      ctx,
      "write",
      signal,
      (api) => api.createComment(prepared.input),
      prepared.expectedConnectionId,
    );
  }

  async #resolveResource(
    api: LinearApi,
    type: LinearResourceType,
    reference: string,
    teamId?: string,
  ): Promise<LinearResourceSummary> {
    const normalized = reference.trim().toLowerCase();
    const candidates: LinearResourceSummary[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const result = await api.resources({ type, limit: 100, cursor });
      candidates.push(
        ...result.nodes.filter((item) => !teamId || !item.teamId || item.teamId === teamId),
      );
      if (!result.hasMore) break;
      if (!result.endCursor || seenCursors.has(result.endCursor)) {
        throw linearError(LinearErrorCode.Api, `Linear ${type} pagination did not advance.`, {
          retryable: true,
        });
      }
      seenCursors.add(result.endCursor);
      cursor = result.endCursor;
    }
    const aliases = (item: LinearResourceSummary) =>
      [item.id, item.name, item.key, item.email]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
    const exact = candidates.filter((item) => aliases(item).includes(normalized));
    if (exact.length === 1) return exact[0]!;
    const partial = exact.length
      ? exact
      : candidates.filter((item) => aliases(item).some((alias) => alias.includes(normalized)));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) {
      throw linearError(
        LinearErrorCode.AmbiguousReference,
        `Linear ${type} reference is ambiguous: ${reference}.`,
        {
          recovery: "Use an exact UUID or a unique name, key, or email from linear_list_resources.",
          details: { type, candidates: partial.slice(0, 20) },
        },
      );
    }
    throw linearError(
      LinearErrorCode.NotFound,
      `Linear ${type} resource not found: ${reference}.`,
      {
        recovery: "Use linear_list_resources to find a valid reference.",
        details: { type, reference },
      },
    );
  }

  async #withApi<T>(
    ctx: LinearSelectionContext,
    scope: "read" | "write",
    signal: AbortSignal | undefined,
    operation: (api: LinearApi, connection: LinearConnectionConfig) => Promise<T>,
    expectedConnectionId?: string,
  ): Promise<T> {
    const grant = await this.#auth.accessToken(ctx, scope, signal);
    this.#assertExpectedConnection(grant.connection, expectedConnectionId);
    try {
      return await operation(this.#createApi(grant.accessToken, signal), grant.connection);
    } catch (error) {
      if (!(error instanceof LinearExtensionError) || error.code !== LinearErrorCode.AuthRequired)
        throw error;
      const refreshed = await this.#auth.refreshAfterAuthenticationError(ctx, scope, signal);
      this.#assertExpectedConnection(refreshed.connection, expectedConnectionId);
      return operation(this.#createApi(refreshed.accessToken, signal), refreshed.connection);
    }
  }

  #assertExpectedConnection(
    connection: LinearConnectionConfig,
    expectedConnectionId?: string,
  ): void {
    if (!expectedConnectionId || connection.id === expectedConnectionId) return;
    throw linearError(
      LinearErrorCode.Conflict,
      "The selected Linear connection changed after confirmation.",
      {
        recovery: "Review and confirm the write again for the newly selected connection.",
        details: { expectedConnectionId, selectedConnectionId: connection.id },
      },
    );
  }
}

export { deterministicUuid, stableOperationId };
