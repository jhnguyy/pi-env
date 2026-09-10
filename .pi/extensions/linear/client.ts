import {
  CredentialErrorCode,
  CredentialSourceError,
  type CredentialSource,
} from "../_shared/credential-source";
import type {
  CursorPage,
  IssueSummary,
  LinearApi,
  LinearApiFactory,
  LinearResourceSummary,
  LinearResourceType,
  ViewerSummary,
} from "./api";
import { LinearErrorCode, linearError } from "./domain";

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
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw linearError(
      LinearErrorCode.AmbiguousReference,
      `Linear ${type} reference is ambiguous: ${reference}.`,
      {
        recovery: "Use the Linear list-resources action to find an exact UUID or unique name, key, or email.",
        details: { type, candidates: matches.slice(0, 20) },
      },
    );
  }
  throw linearError(LinearErrorCode.NotFound, `Linear ${type} resource not found: ${reference}.`, {
    recovery: "Use the Linear list-resources action to find a valid reference.",
    details: { type, reference },
  });
}

class ResourceResolver {
  readonly #catalogs = new Map<string, Promise<LinearResourceSummary[]>>();

  constructor(readonly api: LinearApi) {}

  async resolve(type: LinearResourceType, reference: string): Promise<LinearResourceSummary> {
    const key = `${type}:${reference.trim().toLowerCase()}`;
    const existing = this.#catalogs.get(key);
    if (existing) return selectResource(type, reference, await existing);
    const created = this.#load(type, reference);
    this.#catalogs.set(key, created);
    return selectResource(type, reference, await created);
  }

  async #load(type: LinearResourceType, query: string): Promise<LinearResourceSummary[]> {
    const candidates: LinearResourceSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.api.resources({ type, limit: 100, cursor, query });
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

export type CredentialSourceAccess = () => CredentialSource;

export class LinearGateway {
  readonly #credentials: CredentialSourceAccess;
  readonly #createApi: LinearApiFactory;

  constructor(credentials: CredentialSourceAccess, createApi: LinearApiFactory) {
    this.#credentials = credentials;
    this.#createApi = createApi;
  }

  viewer(signal?: AbortSignal): Promise<ViewerSummary> {
    return this.#withApi(signal, (api) => api.viewer());
  }

  listResources(
    input: ListResourcesInput,
    signal?: AbortSignal,
  ): Promise<CursorPage<LinearResourceSummary>> {
    return this.#withApi(signal, (api) =>
      api.resources({
        type: input.type,
        limit: input.limit,
        cursor: input.cursor,
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
      }),
    );
  }

  listIssues(input: ListIssuesInput, signal?: AbortSignal): Promise<CursorPage<IssueSummary>> {
    return this.#withApi(signal, async (api) => {
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

  searchIssues(input: SearchIssuesInput, signal?: AbortSignal): Promise<CursorPage<IssueSummary>> {
    return this.#withApi(signal, async (api) => {
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

  issue(issueId: string, signal?: AbortSignal): Promise<IssueSummary> {
    return this.#withApi(signal, (api) => api.issue(issueId));
  }

  async #withApi<T>(
    signal: AbortSignal | undefined,
    operation: (api: LinearApi) => Promise<T>,
  ): Promise<T> {
    const credentials = this.#credentials();
    if (!credentials.has("linear.apiKey")) {
      throw new CredentialSourceError({
        code: CredentialErrorCode.NotConfigured,
        message: "Credential linear.apiKey is not configured.",
        retryable: false,
        name: "linear.apiKey",
        recovery: "Configure linear.apiKey in the global credentialSource settings and reload Pi.",
      });
    }
    return await credentials.use(
      { name: "linear.apiKey", consumer: "linear" },
      (apiKey) => operation(this.#createApi(apiKey, signal)),
      signal,
    );
  }
}
