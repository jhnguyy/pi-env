import {
  LinearClient,
  LinearError,
  LinearErrorType,
  type Comment,
  type Issue,
  type IssueSearchResult,
} from "@linear/sdk";
import type { LinearAuthContext, LinearAuthManager } from "./auth";

export interface ViewerSummary {
  id: string;
  name: string;
  displayName: string;
  email: string;
  workspace: { id: string; name: string; urlKey: string };
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  priorityLabel: string;
  state?: { id: string; name: string };
  assignee?: { id: string; name: string };
  teamId?: string;
  updatedAt: string;
  url: string;
}

export interface IssueListResult {
  issues: IssueSummary[];
  totalCount?: number;
  hasMore: boolean;
}

export interface CommentSummary {
  id: string;
  issueId?: string;
  createdAt: string;
  url: string;
}

export interface ListIssuesInput {
  limit: number;
  includeArchived?: boolean;
  teamId?: string;
  assigneeId?: string;
}

export interface SearchIssuesInput {
  query: string;
  limit: number;
  includeArchived?: boolean;
  teamId?: string;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  projectId?: string;
  priority?: number;
  dueDate?: string;
  labelIds?: string[];
}

export interface UpdateIssueInput {
  issueId: string;
  title?: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  projectId?: string;
  priority?: number;
  dueDate?: string;
  labelIds?: string[];
}

export interface CreateCommentInput {
  issueId: string;
  body: string;
}

export type LinearClientFactory = (accessToken: string, signal?: AbortSignal) => LinearClient;

type IssueLike = Issue | IssueSearchResult;

async function summarizeIssue(issue: IssueLike, includeDescription = false): Promise<IssueSummary> {
  const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(includeDescription && issue.description
      ? {
          description:
            issue.description.length > 8_000
              ? `${issue.description.slice(0, 8_000)}\n…`
              : issue.description,
        }
      : {}),
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

export class LinearGateway {
  readonly #auth: LinearAuthManager;
  readonly #createClient: LinearClientFactory;

  constructor(
    auth: LinearAuthManager,
    createClient: LinearClientFactory = (accessToken, signal) =>
      new LinearClient({ accessToken, signal }),
  ) {
    this.#auth = auth;
    this.#createClient = createClient;
  }

  async viewer(ctx: LinearAuthContext, signal?: AbortSignal): Promise<ViewerSummary> {
    return this.#withClient(ctx, signal, async (client) => {
      const [viewer, workspace] = await Promise.all([client.viewer, client.organization]);
      return {
        id: viewer.id,
        name: viewer.name,
        displayName: viewer.displayName,
        email: viewer.email,
        workspace: { id: workspace.id, name: workspace.name, urlKey: workspace.urlKey },
      };
    });
  }

  async listIssues(
    input: ListIssuesInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueListResult> {
    return this.#withClient(ctx, signal, async (client) => {
      const filter = {
        ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
        ...(input.assigneeId ? { assignee: { id: { eq: input.assigneeId } } } : {}),
      };
      const connection = await client.issues({
        first: input.limit,
        includeArchived: input.includeArchived,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      });
      return {
        issues: await Promise.all(
          connection.nodes.slice(0, input.limit).map((issue) => summarizeIssue(issue)),
        ),
        hasMore: connection.pageInfo.hasNextPage,
      };
    });
  }

  async searchIssues(
    input: SearchIssuesInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueListResult> {
    return this.#withClient(ctx, signal, async (client) => {
      const result = await client.searchIssues(input.query, {
        first: input.limit,
        includeArchived: input.includeArchived,
        ...(input.teamId ? { teamId: input.teamId } : {}),
      });
      return {
        issues: await Promise.all(
          result.nodes.slice(0, input.limit).map((issue) => summarizeIssue(issue)),
        ),
        totalCount: result.totalCount,
        hasMore: result.pageInfo.hasNextPage,
      };
    });
  }

  async issue(
    issueId: string,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    return this.#withClient(ctx, signal, async (client) =>
      summarizeIssue(await client.issue(issueId), true),
    );
  }

  async createIssue(
    input: CreateIssueInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    return this.#withClient(ctx, signal, async (client) => {
      const payload = await client.createIssue({ ...input });
      const issue = await payload.issue;
      if (!payload.success || !issue) throw new Error("Linear did not return the created issue.");
      return summarizeIssue(issue);
    });
  }

  async updateIssue(
    input: UpdateIssueInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<IssueSummary> {
    return this.#withClient(ctx, signal, async (client) => {
      const { issueId, ...changes } = input;
      if (Object.keys(changes).length === 0)
        throw new Error("linear_update_issue requires at least one field to update.");
      const payload = await client.updateIssue(issueId, changes);
      const issue = await payload.issue;
      if (!payload.success || !issue) throw new Error("Linear did not return the updated issue.");
      return summarizeIssue(issue);
    });
  }

  async createComment(
    input: CreateCommentInput,
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<CommentSummary> {
    return this.#withClient(ctx, signal, async (client) => {
      const payload = await client.createComment(input);
      const comment = await payload.comment;
      if (!payload.success || !comment)
        throw new Error("Linear did not return the created comment.");
      return summarizeComment(comment);
    });
  }

  async #withClient<T>(
    ctx: LinearAuthContext,
    signal: AbortSignal | undefined,
    operation: (client: LinearClient) => Promise<T>,
  ): Promise<T> {
    const accessToken = await this.#auth.accessToken(ctx, signal);
    try {
      return await operation(this.#createClient(accessToken, signal));
    } catch (error) {
      if (!isAuthenticationError(error)) throw error;
      const refreshedToken = await this.#auth.refreshAfterAuthenticationError(ctx, signal);
      return operation(this.#createClient(refreshedToken, signal));
    }
  }
}

function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof LinearError &&
    (error.type === LinearErrorType.AuthenticationError || error.status === 401)
  );
}
