import {
  LinearClient,
  LinearError,
  LinearErrorType,
  type Comment,
  type Issue,
  type IssueSearchResult,
} from "@linear/sdk";
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
  nodes: T[],
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
    nodes,
    hasMore: pageInfo.hasNextPage,
    ...(pageInfo.endCursor ? { endCursor: pageInfo.endCursor } : {}),
    ...(totalCount === undefined ? {} : { totalCount }),
  };
}

function mapSdkError(error: unknown): never {
  if (error instanceof LinearExtensionError) throw error;
  if (!(error instanceof LinearError))
    throw linearError(
      LinearErrorCode.Api,
      error instanceof Error ? error.message : "Linear API failed.",
      { cause: error },
    );
  const details = error.status ? { status: error.status } : undefined;
  if (error.status === 401) {
    throw linearError(LinearErrorCode.AuthRequired, "Linear rejected the access token.", {
      retryable: true,
    });
  }
  switch (error.type) {
    case LinearErrorType.AuthenticationError:
      throw linearError(LinearErrorCode.AuthRequired, "Linear rejected the access token.", {
        retryable: true,
      });
    case LinearErrorType.Ratelimited:
      throw linearError(LinearErrorCode.RateLimited, "Linear rate-limited the request.", {
        retryable: true,
        details,
      });
    case LinearErrorType.NetworkError:
      throw linearError(LinearErrorCode.NetworkUnavailable, "Cannot reach the Linear API.", {
        retryable: true,
        details,
      });
    case LinearErrorType.Forbidden:
      throw linearError(LinearErrorCode.Forbidden, "Linear denied this operation.", { details });
    case LinearErrorType.InvalidInput:
    case LinearErrorType.UserError:
      throw linearError(
        LinearErrorCode.Validation,
        error.message || "Linear rejected the request.",
        { details },
      );
    default:
      if (error.status === 404)
        throw linearError(LinearErrorCode.NotFound, "Linear resource not found.", { details });
      throw linearError(LinearErrorCode.Api, error.message || "Linear API failed.", {
        retryable: Boolean(error.status && error.status >= 500),
        details,
      });
  }
}

export class LinearSdkApi implements LinearApi {
  readonly #client: LinearClient;

  constructor(accessToken: string, signal?: AbortSignal) {
    this.#client = new LinearClient({ accessToken, signal });
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
      const variables = { first: input.limit, after: input.cursor };
      switch (input.type) {
        case "teams": {
          const result = await this.#client.teams(variables);
          return sdkCursorPage(
            result.nodes.map((item) => ({
              type: input.type,
              id: item.id,
              name: item.name,
              key: item.key,
            })),
            result.pageInfo,
            undefined,
            input.cursor,
          );
        }
        case "users": {
          const result = await this.#client.users(variables);
          return sdkCursorPage(
            result.nodes.map((item) => ({
              type: input.type,
              id: item.id,
              name: item.name,
              email: item.email,
            })),
            result.pageInfo,
            undefined,
            input.cursor,
          );
        }
        case "states": {
          const result = await this.#client.workflowStates(variables);
          return sdkCursorPage(
            result.nodes.map((item) => ({
              type: input.type,
              id: item.id,
              name: item.name,
              ...(item.teamId ? { teamId: item.teamId } : {}),
            })),
            result.pageInfo,
            undefined,
            input.cursor,
          );
        }
        case "projects": {
          const result = await this.#client.projects(variables);
          return sdkCursorPage(
            result.nodes.map((item) => ({ type: input.type, id: item.id, name: item.name })),
            result.pageInfo,
            undefined,
            input.cursor,
          );
        }
        case "labels": {
          const result = await this.#client.issueLabels(variables);
          return sdkCursorPage(
            result.nodes.map((item) => ({
              type: input.type,
              id: item.id,
              name: item.name,
              ...(item.teamId ? { teamId: item.teamId } : {}),
            })),
            result.pageInfo,
            undefined,
            input.cursor,
          );
        }
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

export const createLinearSdkApi: LinearApiFactory = (accessToken, signal) =>
  new LinearSdkApi(accessToken, signal);
