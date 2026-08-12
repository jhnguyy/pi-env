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

function optionalRelation<T>(
  clear: boolean | undefined,
  value: T | undefined,
): T | null | undefined {
  return clear ? null : value;
}

function updateApiInput(
  input: UpdateIssueInput,
  resources: {
    assignee?: LinearResourceSummary;
    state?: LinearResourceSummary;
    project?: LinearResourceSummary;
    labels: LinearResourceSummary[];
  },
): UpdateIssueApiInput {
  const assigneeId = optionalRelation(input.clearAssignee, resources.assignee?.id);
  const projectId = optionalRelation(input.clearProject, resources.project?.id);
  const dueDate = optionalRelation(input.clearDueDate, input.dueDate);
  return {
    issueId: input.issueId,
    title: input.title,
    description: input.description,
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(resources.state ? { stateId: resources.state.id } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    priority: input.priority,
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(input.clearLabels
      ? { labelIds: [] }
      : input.labels
        ? { labelIds: resources.labels.map((label) => label.id) }
        : {}),
  };
}

function updatePreview(
  input: UpdateIssueInput,
  resources: {
    assignee?: LinearResourceSummary;
    state?: LinearResourceSummary;
    project?: LinearResourceSummary;
    labels: LinearResourceSummary[];
  },
) {
  return {
    title: input.title,
    description: input.description,
    assignee: optionalRelation(input.clearAssignee, resources.assignee),
    state: resources.state,
    project: optionalRelation(input.clearProject, resources.project),
    priority: input.priority,
    dueDate: optionalRelation(input.clearDueDate, input.dueDate),
    labels: input.clearLabels ? [] : resources.labels,
  };
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

function resourceAliases(item: LinearResourceSummary): string[] {
  return [item.id, item.name, item.key, item.email]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

function selectResource(
  type: LinearResourceType,
  reference: string,
  candidates: LinearResourceSummary[],
): LinearResourceSummary {
  const normalized = reference.trim().toLowerCase();
  const exact = candidates.filter((item) => resourceAliases(item).includes(normalized));
  const matches = exact.length
    ? exact
    : candidates.filter((item) =>
        resourceAliases(item).some((alias) => alias.includes(normalized)),
      );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw linearError(
      LinearErrorCode.AmbiguousReference,
      `Linear ${type} reference is ambiguous: ${reference}.`,
      {
        recovery: "Use an exact UUID or a unique name, key, or email from linear_list_resources.",
        details: { type, candidates: matches.slice(0, 20) },
      },
    );
  }
  throw linearError(LinearErrorCode.NotFound, `Linear ${type} resource not found: ${reference}.`, {
    recovery: "Use linear_list_resources to find a valid reference.",
    details: { type, reference },
  });
}

class ResourceResolver {
  readonly #catalogs = new Map<string, Promise<LinearResourceSummary[]>>();

  constructor(readonly api: LinearApi) {}

  async resolve(
    type: LinearResourceType,
    reference: string,
    teamId?: string,
  ): Promise<LinearResourceSummary> {
    const candidates = await this.#catalog(type, reference, teamId);
    return selectResource(type, reference, candidates);
  }

  async resolveMany(
    type: LinearResourceType,
    references: readonly string[],
    teamId?: string,
  ): Promise<LinearResourceSummary[]> {
    if (!references.length) return [];
    const candidates = await this.#catalog(type, undefined, teamId);
    return references.map((reference) => selectResource(type, reference, candidates));
  }

  #catalog(
    type: LinearResourceType,
    query: string | undefined,
    teamId: string | undefined,
  ): Promise<LinearResourceSummary[]> {
    const key = `${type}:${teamId ?? ""}:${query?.trim().toLowerCase() ?? "*"}`;
    const existing = this.#catalogs.get(key);
    if (existing) return existing;
    const created = this.#load(type, query, teamId);
    this.#catalogs.set(key, created);
    return created;
  }

  async #load(
    type: LinearResourceType,
    query: string | undefined,
    teamId: string | undefined,
  ): Promise<LinearResourceSummary[]> {
    const candidates: LinearResourceSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.api.resources({ type, limit: 100, cursor, query, teamId });
      candidates.push(...result.nodes);
      if (!result.hasMore) break;
      if (!result.endCursor || seen.has(result.endCursor)) {
        throw linearError(LinearErrorCode.Api, `Linear ${type} pagination did not advance.`, {
          retryable: true,
        });
      }
      seen.add(result.endCursor);
      cursor = result.endCursor;
    } while (true);
    return candidates;
  }
}

async function resolveIssueFilters(
  resolver: ResourceResolver,
  input: Pick<ListIssuesInput, "team" | "assignee">,
): Promise<{ teamId?: string; assigneeId?: string }> {
  const [team, assignee] = await Promise.all([
    input.team ? resolver.resolve("teams", input.team) : undefined,
    input.assignee ? resolver.resolve("users", input.assignee) : undefined,
  ]);
  return { teamId: team?.id, assigneeId: assignee?.id };
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
      return api.resources({
        type: input.type,
        limit: input.limit,
        cursor: input.cursor,
        query: input.query.trim(),
      });
    });
  }

  listIssues(
    input: ListIssuesInput,
    ctx: LinearSelectionContext,
    signal?: AbortSignal,
  ): Promise<CursorPage<IssueSummary>> {
    return this.#withApi(ctx, "read", signal, async (api) => {
      const resolver = new ResourceResolver(api);
      const { teamId, assigneeId } = await resolveIssueFilters(resolver, input);
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
      const resolver = new ResourceResolver(api);
      const { teamId, assigneeId } = await resolveIssueFilters(resolver, input);
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
      const resolver = new ResourceResolver(api);
      const team = await resolver.resolve("teams", input.team);
      const [assignee, state, project, labels] = await Promise.all([
        input.assignee ? resolver.resolve("users", input.assignee) : undefined,
        input.state ? resolver.resolve("states", input.state, team.id) : undefined,
        input.project ? resolver.resolve("projects", input.project) : undefined,
        resolver.resolveMany("labels", input.labels ?? [], team.id),
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
      const resolver = new ResourceResolver(api);
      const [assignee, state, project, labels] = await Promise.all([
        input.assignee ? resolver.resolve("users", input.assignee) : undefined,
        input.state ? resolver.resolve("states", input.state, current.teamId) : undefined,
        input.project ? resolver.resolve("projects", input.project) : undefined,
        resolver.resolveMany("labels", input.labels ?? [], current.teamId),
      ]);
      const resources = { assignee, state, project, labels };
      const apiInput = updateApiInput(input, resources);
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
          changes: updatePreview(input, resources),
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
