import {
  LinearClient,
  LinearError,
  LinearErrorType,
  type Comment,
  type Issue,
  type IssueSearchResult,
} from "@linear/sdk";
import { LinearResourceType } from "./api";
import type {
  CommentSummary,
  CreateCommentApiInput,
  CreateIssueApiInput,
  CursorPage,
  IssuePageInput,
  IssueSummary,
  LinearApi,
  LinearApiFactory,
  LinearIdentity,
  LinearResourceSummary,
  ResourcePageInput,
  SearchIssuePageInput,
  UpdateIssueApiInput,
  ViewerSummary,
} from "./api";
import { LinearErrorCode, LinearExtensionError, linearError } from "./domain";

type IssueLike = Issue | IssueSearchResult;

type StringFilter = { containsIgnoreCase: string };

type ResourceQueryFilter = {
  id: { eq: string };
  text: StringFilter;
};

function resourceFilter(input: ResourcePageInput): ResourceQueryFilter | undefined {
  const query = input.query?.trim();
  return query ? { id: { eq: query }, text: { containsIgnoreCase: query } } : undefined;
}

function teamConstraint(teamId: string | undefined) {
  return teamId ? { team: { id: { eq: teamId } } } : {};
}

export function sdkResourceVariables(input: ResourcePageInput): Record<string, unknown> {
  const common = { first: input.limit, after: input.cursor };
  const filter = resourceFilter(input);
  switch (input.type) {
    case LinearResourceType.Teams:
      return {
        ...common,
        ...(filter
          ? { filter: { or: [{ id: filter.id }, { key: filter.text }, { name: filter.text }] } }
          : {}),
      };
    case LinearResourceType.Users:
      return {
        ...common,
        ...(filter
          ? {
              filter: {
                or: [
                  { id: filter.id },
                  { email: filter.text },
                  { name: filter.text },
                  { displayName: filter.text },
                ],
              },
            }
          : {}),
      };
    case LinearResourceType.States:
    case LinearResourceType.Labels:
      return {
        ...common,
        ...((filter || input.teamId) && {
          filter: {
            ...teamConstraint(input.teamId),
            ...(filter ? { or: [{ id: filter.id }, { name: filter.text }] } : {}),
          },
        }),
      };
    case LinearResourceType.Projects:
      return {
        ...common,
        ...(filter ? { filter: { or: [{ id: filter.id }, { name: filter.text }] } } : {}),
      };
  }
}

async function summarizeIssue(issue: IssueLike, includeDescription = false): Promise<IssueSummary> {
  const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
  const description =
    includeDescription && issue.description
      ? issue.description.length > 8_000
        ? `${issue.description.slice(0, 8_000)}\n…`
        : issue.description
      : undefined;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(description ? { description } : {}),
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    ...(state ? { state: { id: state.id, name: state.name } } : {}),
    ...(assignee ? { assignee: { id: assignee.id, name: assignee.name } } : {}),
    ...(issue.teamId ? { teamId: issue.teamId } : {}),
    updatedAt: issue.updatedAt.toISOString(),
    url: issue.url,
  };
}

function summarizeComment(comment: Comment): CommentSummary {
  return {
    id: comment.id,
    ...(comment.issueId ? { issueId: comment.issueId } : {}),
    createdAt: comment.createdAt.toISOString(),
    url: comment.url,
  };
}

export function sdkCursorPage<T>(
  nodes: readonly T[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null },
  totalCount?: number,
  inputCursor?: string,
): CursorPage<T> {
  if (pageInfo.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === inputCursor)) {
    throw linearError(LinearErrorCode.Api, "Linear pagination did not return a new end cursor.", {
      retryable: true,
    });
  }
  return {
    nodes: [...nodes],
    hasMore: pageInfo.hasNextPage,
    ...(pageInfo.endCursor ? { endCursor: pageInfo.endCursor } : {}),
    ...(totalCount === undefined ? {} : { totalCount }),
  };
}

const SDK_ERROR_CODES: Partial<Record<LinearErrorType, LinearErrorCode>> = {
  [LinearErrorType.AuthenticationError]: LinearErrorCode.AuthRequired,
  [LinearErrorType.Ratelimited]: LinearErrorCode.RateLimited,
  [LinearErrorType.NetworkError]: LinearErrorCode.NetworkUnavailable,
  [LinearErrorType.Forbidden]: LinearErrorCode.Forbidden,
  [LinearErrorType.InvalidInput]: LinearErrorCode.Validation,
  [LinearErrorType.UserError]: LinearErrorCode.Validation,
};

const SDK_ERROR_MESSAGES: Partial<Record<LinearErrorCode, string>> = {
  [LinearErrorCode.AuthRequired]: "Linear rejected the access token.",
  [LinearErrorCode.RateLimited]: "Linear rate-limited the request.",
  [LinearErrorCode.NetworkUnavailable]: "Cannot reach the Linear API.",
  [LinearErrorCode.Forbidden]: "Linear denied this operation.",
  [LinearErrorCode.NotFound]: "Linear resource not found.",
};

function mapSdkError(error: unknown): never {
  if (error instanceof LinearExtensionError) throw error;
  if (!(error instanceof LinearError)) {
    throw linearError(LinearErrorCode.Api, "Linear API failed.", { cause: error });
  }
  const code =
    error.status === 401
      ? LinearErrorCode.AuthRequired
      : error.status === 404
        ? LinearErrorCode.NotFound
        : error.type === undefined
          ? LinearErrorCode.Api
          : (SDK_ERROR_CODES[error.type] ?? LinearErrorCode.Api);
  const retryable =
    code === LinearErrorCode.AuthRequired ||
    code === LinearErrorCode.RateLimited ||
    code === LinearErrorCode.NetworkUnavailable ||
    Boolean(error.status && error.status >= 500);
  throw linearError(code, SDK_ERROR_MESSAGES[code] ?? error.message ?? "Linear API failed.", {
    retryable,
    ...(error.status ? { details: { status: error.status } } : {}),
  });
}

function resourcePage<T>(
  input: ResourcePageInput,
  result: { nodes: readonly T[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } },
  summarize: (item: T) => LinearResourceSummary,
): CursorPage<LinearResourceSummary> {
  return sdkCursorPage(result.nodes.map(summarize), result.pageInfo, undefined, input.cursor);
}

export class LinearSdkApi implements LinearApi {
  readonly #client: LinearClient;

  constructor(apiKey: string, signal?: AbortSignal) {
    this.#client = new LinearClient({ apiKey, signal });
  }

  identity(): Promise<LinearIdentity> {
    return this.#guard(async () => {
      const [viewer, organization] = await Promise.all([
        this.#client.viewer,
        this.#client.organization,
      ]);
      return {
        organization: { id: organization.id, name: organization.name, urlKey: organization.urlKey },
        viewer: {
          id: viewer.id,
          name: viewer.name,
          displayName: viewer.displayName,
          email: viewer.email,
        },
      };
    });
  }

  viewer(): Promise<ViewerSummary> {
    return this.identity();
  }

  listIssues(input: IssuePageInput): Promise<CursorPage<IssueSummary>> {
    return this.#guard(async () => {
      const filter = {
        ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
        ...(input.assigneeId ? { assignee: { id: { eq: input.assigneeId } } } : {}),
      };
      const result = await this.#client.issues({
        first: input.limit,
        after: input.cursor,
        includeArchived: input.includeArchived,
        ...(Object.keys(filter).length ? { filter } : {}),
      });
      return sdkCursorPage(
        await Promise.all(result.nodes.slice(0, input.limit).map((issue) => summarizeIssue(issue))),
        result.pageInfo,
        undefined,
        input.cursor,
      );
    });
  }

  searchIssues(input: SearchIssuePageInput): Promise<CursorPage<IssueSummary>> {
    return this.#guard(async () => {
      const result = await this.#client.searchIssues(input.query, {
        first: input.limit,
        after: input.cursor,
        includeArchived: input.includeArchived,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.assigneeId ? { filter: { assignee: { id: { eq: input.assigneeId } } } } : {}),
      });
      return sdkCursorPage(
        await Promise.all(result.nodes.slice(0, input.limit).map((issue) => summarizeIssue(issue))),
        result.pageInfo,
        result.totalCount,
        input.cursor,
      );
    });
  }

  issue(issueId: string): Promise<IssueSummary> {
    return this.#guard(async () => summarizeIssue(await this.#client.issue(issueId), true));
  }

  resources(input: ResourcePageInput): Promise<CursorPage<LinearResourceSummary>> {
    return this.#guard(async () => {
      const variables = sdkResourceVariables(input);
      switch (input.type) {
        case LinearResourceType.Teams:
          return resourcePage(input, await this.#client.teams(variables), (item) => ({
            type: input.type,
            id: item.id,
            name: item.name,
            key: item.key,
          }));
        case LinearResourceType.Users:
          return resourcePage(input, await this.#client.users(variables), (item) => ({
            type: input.type,
            id: item.id,
            name: item.name,
            email: item.email,
          }));
        case LinearResourceType.States:
          return resourcePage(input, await this.#client.workflowStates(variables), (item) => ({
            type: input.type,
            id: item.id,
            name: item.name,
            ...(item.teamId ? { teamId: item.teamId } : {}),
          }));
        case LinearResourceType.Projects:
          return resourcePage(input, await this.#client.projects(variables), (item) => ({
            type: input.type,
            id: item.id,
            name: item.name,
          }));
        case LinearResourceType.Labels:
          return resourcePage(input, await this.#client.issueLabels(variables), (item) => ({
            type: input.type,
            id: item.id,
            name: item.name,
            ...(item.teamId ? { teamId: item.teamId } : {}),
          }));
      }
    });
  }

  createIssue(input: CreateIssueApiInput): Promise<IssueSummary> {
    return this.#guard(async () => {
      try {
        const payload = await this.#client.createIssue(input);
        const issue = await payload.issue;
        if (!payload.success || !issue)
          throw linearError(LinearErrorCode.Api, "Linear did not return the created issue.");
        return summarizeIssue(issue);
      } catch (error) {
        try {
          return await summarizeIssue(await this.#client.issue(input.id));
        } catch {
          throw error;
        }
      }
    });
  }

  updateIssue(input: UpdateIssueApiInput): Promise<IssueSummary> {
    return this.#guard(async () => {
      const { issueId, ...changes } = input;
      const payload = await this.#client.updateIssue(issueId, changes);
      const issue = await payload.issue;
      if (!payload.success || !issue)
        throw linearError(LinearErrorCode.Api, "Linear did not return the updated issue.");
      return summarizeIssue(issue);
    });
  }

  createComment(input: CreateCommentApiInput): Promise<CommentSummary> {
    return this.#guard(async () => {
      try {
        const payload = await this.#client.createComment(input);
        const comment = await payload.comment;
        if (!payload.success || !comment)
          throw linearError(LinearErrorCode.Api, "Linear did not return the created comment.");
        return summarizeComment(comment);
      } catch (error) {
        try {
          return summarizeComment(await this.#client.comment({ id: input.id }));
        } catch {
          throw error;
        }
      }
    });
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      mapSdkError(error);
    }
  }
}

export const createLinearSdkApi: LinearApiFactory = (apiKey, signal) =>
  new LinearSdkApi(apiKey, signal);
