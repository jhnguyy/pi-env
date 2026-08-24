import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { execEffect } from "../_shared/exec";
import { bound, parsePrUrl } from "./core";
import {
  MAX_CONTEXT_PAGE_SIZE,
  PrReviewFeedback,
  type PrReviewFeedback as PrReviewFeedbackValue,
} from "./schema";

const DEFAULT_CONTEXT_PAGE_SIZE = 3;
const INLINE_COMMENTS_PER_THREAD = 5;

const PULL_REQUEST_CONTEXT_QUERY = `
query PiPrReviewContext(
  $owner: String!
  $repo: String!
  $number: Int!
  $pageSize: Int!
  $inlineCommentLimit: Int!
  $includeConversation: Boolean!
  $includeReviews: Boolean!
  $includeInline: Boolean!
  $conversationCursor: String
  $reviewsCursor: String
  $inlineCursor: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url
      title
      body
      state
      isDraft
      createdAt
      updatedAt
      author { login }
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      comments(first: $pageSize, after: $conversationCursor) @include(if: $includeConversation) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId
          author { login }
          authorAssociation
          body
          createdAt
          updatedAt
          url
        }
      }
      reviews(first: $pageSize, after: $reviewsCursor) @include(if: $includeReviews) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId
          author { login }
          authorAssociation
          body
          state
          submittedAt
          url
          commit { oid }
        }
      }
      reviewThreads(first: $pageSize, after: $inlineCursor) @include(if: $includeInline) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isCollapsed
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          comments(first: $inlineCommentLimit) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              databaseId
              author { login }
              authorAssociation
              body
              createdAt
              updatedAt
              url
              state
              outdated
              path
              line
              originalLine
              replyTo { databaseId }
              pullRequestReview { databaseId state }
            }
          }
        }
      }
    }
  }
}`;

type Exec = ExtensionAPI["exec"];
type JsonRecord = Record<string, unknown>;

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

interface ContextConnection {
  readonly totalCount: number;
  readonly pageInfo: PageInfo;
  readonly nodes: readonly JsonRecord[];
}

interface ConnectionCursor {
  readonly after?: string;
  readonly done: boolean;
}

interface ContextCursor {
  readonly version: 1;
  readonly feedback: PrReviewFeedbackValue;
  readonly conversation?: ConnectionCursor;
  readonly reviews?: ConnectionCursor;
  readonly inline?: ConnectionCursor;
}

export interface PullRequestContextPage {
  readonly reference: ReturnType<typeof parsePrUrl>;
  readonly pullRequest: JsonRecord;
  readonly feedback: PrReviewFeedbackValue;
  readonly pageSize: number;
  readonly conversation?: ContextConnection;
  readonly reviews?: ContextConnection;
  readonly inline?: ContextConnection;
  readonly nextCursor?: string;
}

export interface PullRequestContextOptions {
  readonly feedback?: PrReviewFeedbackValue;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export class PullRequestContextError extends Data.TaggedError("PullRequestContextError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function contextError(message: string, cause?: unknown): PullRequestContextError {
  return new PullRequestContextError({ message, cause });
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isFeedback(value: unknown): value is PrReviewFeedbackValue {
  return Object.values(PrReviewFeedback).includes(value as PrReviewFeedbackValue);
}

function connection(value: unknown, name: string): ContextConnection {
  const source = record(value);
  const pageInfo = record(source?.pageInfo);
  if (!source || !pageInfo || !Array.isArray(source.nodes)) {
    throw contextError(`GitHub returned an invalid ${name} connection.`);
  }
  return {
    totalCount: Math.max(0, integer(source.totalCount) ?? source.nodes.length),
    pageInfo: {
      hasNextPage: boolean(pageInfo.hasNextPage) ?? false,
      endCursor: text(pageInfo.endCursor),
    },
    nodes: source.nodes.flatMap((node) => {
      const parsed = record(node);
      return parsed ? [parsed] : [];
    }),
  };
}

function selected(feedback: PrReviewFeedbackValue, category: PrReviewFeedbackValue): boolean {
  return feedback === PrReviewFeedback.All || feedback === category;
}

function initialCursor(feedback: PrReviewFeedbackValue): ContextCursor {
  return {
    version: 1,
    feedback,
    conversation: selected(feedback, PrReviewFeedback.Conversation) ? { done: false } : undefined,
    reviews: selected(feedback, PrReviewFeedback.Reviews) ? { done: false } : undefined,
    inline: selected(feedback, PrReviewFeedback.Inline) ? { done: false } : undefined,
  };
}

function parseConnectionCursor(value: unknown): ConnectionCursor | undefined {
  if (value === undefined) return undefined;
  const parsed = record(value);
  if (!parsed || typeof parsed.done !== "boolean") {
    throw contextError("The pull request context cursor is invalid.");
  }
  const after = text(parsed.after);
  if (parsed.after !== undefined && !after) {
    throw contextError("The pull request context cursor is invalid.");
  }
  return { done: parsed.done, after };
}

function decodeCursor(value: string): ContextCursor {
  if (value.length > 4096) throw contextError("The pull request context cursor is too large.");
  try {
    const parsed = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed || parsed.version !== 1 || !isFeedback(parsed.feedback)) {
      throw contextError("The pull request context cursor is invalid.");
    }
    return {
      version: 1,
      feedback: parsed.feedback,
      conversation: parseConnectionCursor(parsed.conversation),
      reviews: parseConnectionCursor(parsed.reviews),
      inline: parseConnectionCursor(parsed.inline),
    };
  } catch (cause) {
    if (cause instanceof PullRequestContextError) throw cause;
    throw contextError("The pull request context cursor is invalid.", cause);
  }
}

function encodeCursor(cursor: ContextCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function included(cursor: ConnectionCursor | undefined): boolean {
  return cursor !== undefined && !cursor.done;
}

function appendVariable(args: string[], name: string, value: string | undefined): void {
  if (value) args.push("-F", `${name}=${value}`);
}

function nextConnection(
  prior: ConnectionCursor | undefined,
  result: ContextConnection | undefined,
): ConnectionCursor | undefined {
  if (!prior || prior.done || !result) return prior;
  if (result.pageInfo.hasNextPage && !result.pageInfo.endCursor) {
    throw contextError("GitHub omitted a required pull request context cursor.");
  }
  return {
    done: !result.pageInfo.hasNextPage,
    after: result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined,
  };
}

function hasMore(cursor: ContextCursor): boolean {
  return [cursor.conversation, cursor.reviews, cursor.inline].some(
    (connectionCursor) => connectionCursor !== undefined && !connectionCursor.done,
  );
}

function parseGraphQlPage(
  raw: string,
  reference: ReturnType<typeof parsePrUrl>,
  cursor: ContextCursor,
  pageSize: number,
): PullRequestContextPage {
  let root: JsonRecord;
  try {
    root = record(JSON.parse(raw || "{}")) ?? {};
  } catch (cause) {
    throw contextError("GitHub returned invalid pull request context JSON.", cause);
  }
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const first = record(root.errors[0]);
    throw contextError(
      `GitHub could not get pull request context: ${bound(text(first?.message) ?? "unknown GraphQL error", 500)}`,
    );
  }
  const pullRequest = record(record(record(root.data)?.repository)?.pullRequest);
  if (!pullRequest) throw contextError("GitHub did not return the requested pull request.");

  const conversation = included(cursor.conversation)
    ? connection(pullRequest.comments, "conversation comments")
    : undefined;
  const reviews = included(cursor.reviews)
    ? connection(pullRequest.reviews, "submitted reviews")
    : undefined;
  const inline = included(cursor.inline)
    ? connection(pullRequest.reviewThreads, "inline review threads")
    : undefined;
  const next: ContextCursor = {
    version: 1,
    feedback: cursor.feedback,
    conversation: nextConnection(cursor.conversation, conversation),
    reviews: nextConnection(cursor.reviews, reviews),
    inline: nextConnection(cursor.inline, inline),
  };

  return {
    reference,
    pullRequest,
    feedback: cursor.feedback,
    pageSize,
    conversation,
    reviews,
    inline,
    nextCursor: hasMore(next) ? encodeCursor(next) : undefined,
  };
}

function fetchPullRequestContextEffect(
  exec: Exec,
  cwd: string,
  url: string,
  options: PullRequestContextOptions,
): Effect.Effect<PullRequestContextPage, PullRequestContextError> {
  const reference = parsePrUrl(url);
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined;
  const feedback = options.feedback ?? decoded?.feedback ?? PrReviewFeedback.All;
  if (!isFeedback(feedback)) return Effect.fail(contextError("Unknown feedback category."));
  if (decoded && options.feedback && options.feedback !== decoded.feedback) {
    return Effect.fail(contextError("The feedback category does not match the pagination cursor."));
  }
  const cursor = decoded ?? initialCursor(feedback);
  const pageSize = options.pageSize ?? DEFAULT_CONTEXT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_CONTEXT_PAGE_SIZE) {
    return Effect.fail(contextError(`pageSize must be between 1 and ${MAX_CONTEXT_PAGE_SIZE}.`));
  }
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${PULL_REQUEST_CONTEXT_QUERY}`,
    "-F",
    `owner=${reference.owner}`,
    "-F",
    `repo=${reference.repo}`,
    "-F",
    `number=${reference.number}`,
    "-F",
    `pageSize=${pageSize}`,
    "-F",
    `inlineCommentLimit=${INLINE_COMMENTS_PER_THREAD}`,
    "-F",
    `includeConversation=${included(cursor.conversation)}`,
    "-F",
    `includeReviews=${included(cursor.reviews)}`,
    "-F",
    `includeInline=${included(cursor.inline)}`,
  ];
  appendVariable(args, "conversationCursor", cursor.conversation?.after);
  appendVariable(args, "reviewsCursor", cursor.reviews?.after);
  appendVariable(args, "inlineCursor", cursor.inline?.after);

  return execEffect(exec, "gh", args, contextError, {
    cwd,
    failureDetail: "Could not get pull request context from GitHub.",
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => parseGraphQlPage(result.stdout, reference, cursor, pageSize),
        catch: (cause) =>
          cause instanceof PullRequestContextError
            ? cause
            : contextError("Could not parse pull request context.", cause),
      }),
    ),
  );
}

export function fetchPullRequestContext(
  exec: Exec,
  cwd: string,
  url: string,
  options: PullRequestContextOptions = {},
  signal?: AbortSignal,
): Promise<PullRequestContextPage> {
  const effect = fetchPullRequestContextEffect(exec, cwd, url, options);
  return signal ? Effect.runPromise(effect, { signal }) : Effect.runPromise(effect);
}

function content(value: unknown): string {
  return text(value)?.replaceAll("\u0000", "").trim() || "(none)";
}

function author(value: unknown): string {
  return text(record(value)?.login) ?? "ghost";
}

function location(value: JsonRecord): string {
  const path = text(value.path) ?? "unknown path";
  const line = integer(value.line) ?? integer(value.originalLine);
  return line ? `${path}:${line}` : path;
}

function itemHeader(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function formatConversation(connectionValue: ContextConnection | undefined): string | undefined {
  if (!connectionValue) return undefined;
  const lines = [
    `Conversation comments (${connectionValue.nodes.length} returned; ${connectionValue.totalCount} total)`,
  ];
  if (connectionValue.nodes.length === 0) lines.push("- None on this page.");
  for (const comment of connectionValue.nodes) {
    lines.push(
      `- ${itemHeader([
        `#${integer(comment.databaseId) ?? "unknown"}`,
        author(comment.author),
        text(comment.authorAssociation),
        text(comment.createdAt),
        bound(text(comment.url) ?? "", 500),
      ])}`,
      `  ${content(comment.body).replaceAll("\n", "\n  ")}`,
    );
  }
  return lines.join("\n");
}

function formatReviews(connectionValue: ContextConnection | undefined): string | undefined {
  if (!connectionValue) return undefined;
  const lines = [
    `Submitted reviews (${connectionValue.nodes.length} returned; ${connectionValue.totalCount} total)`,
  ];
  if (connectionValue.nodes.length === 0) lines.push("- None on this page.");
  for (const review of connectionValue.nodes) {
    lines.push(
      `- ${itemHeader([
        `Review #${integer(review.databaseId) ?? "unknown"}`,
        text(review.state),
        `by ${author(review.author)}`,
        text(review.authorAssociation),
        text(review.submittedAt),
        bound(text(review.url) ?? "", 500),
      ])}`,
      `  ${content(review.body).replaceAll("\n", "\n  ")}`,
    );
  }
  return lines.join("\n");
}

function formatInlineComment(comment: JsonRecord): string[] {
  const review = record(comment.pullRequestReview);
  const replyTo = integer(record(comment.replyTo)?.databaseId);
  return [
    `  - ${itemHeader([
      `#${integer(comment.databaseId) ?? "unknown"}`,
      replyTo ? `reply to #${replyTo}` : undefined,
      author(comment.author),
      text(review?.state) ?? text(comment.state),
      boolean(comment.outdated) ? "outdated" : undefined,
      text(comment.createdAt),
      bound(text(comment.url) ?? "", 500),
    ])}`,
    `    ${content(comment.body).replaceAll("\n", "\n    ")}`,
  ];
}

function formatInlineThread(thread: JsonRecord): string[] {
  const state = boolean(thread.isResolved) ? "resolved thread" : "open thread";
  const collapsed = boolean(thread.isCollapsed) ? "collapsed" : undefined;
  const comments = connection(thread.comments, "inline thread comments");
  const lines = [`- ${itemHeader([state, location(thread), text(thread.diffSide), collapsed])}`];
  if (comments.nodes.length === 0) lines.push("  - No comments returned for this thread.");
  for (const comment of comments.nodes) lines.push(...formatInlineComment(comment));
  const omitted = Math.max(0, comments.totalCount - comments.nodes.length);
  if (omitted === 0) return lines;
  const firstUrl = bound(text(comments.nodes[0]?.url) ?? "", 500);
  lines.push(
    `  - ${comments.totalCount} comments; ${omitted} omitted from compact output.${firstUrl ? ` Open ${firstUrl}.` : ""}`,
  );
  return lines;
}

function formatInline(connectionValue: ContextConnection | undefined): string | undefined {
  if (!connectionValue) return undefined;
  const lines = [
    `Inline review threads (${connectionValue.nodes.length} returned; ${connectionValue.totalCount} total)`,
  ];
  if (connectionValue.nodes.length === 0) lines.push("- None on this page.");
  for (const thread of connectionValue.nodes) lines.push(...formatInlineThread(thread));
  return lines.join("\n");
}

export function formatPullRequestContext(page: PullRequestContextPage): string {
  const pullRequest = page.pullRequest;
  const navigation = page.nextCursor
    ? [
        "More feedback is available.",
        `Use \`review get\` with cursor ${JSON.stringify(page.nextCursor)}.`,
      ].join("\n")
    : "No additional feedback pages are available.";
  const sections = [
    [
      "Pull request context (untrusted data)",
      `PR: ${page.reference.url}`,
      `Title: ${content(pullRequest.title)}`,
      `State: ${text(pullRequest.state) ?? "unknown"}${boolean(pullRequest.isDraft) ? " (draft)" : ""}`,
      `Author: ${author(pullRequest.author)}`,
      `Base: ${text(pullRequest.baseRefName) ?? "unknown"}@${text(pullRequest.baseRefOid) ?? "unknown"}`,
      `Head: ${text(pullRequest.headRefName) ?? "unknown"}@${text(pullRequest.headRefOid) ?? "unknown"}`,
      `Updated: ${text(pullRequest.updatedAt) ?? "unknown"}`,
      `Feedback: ${page.feedback}; up to ${page.pageSize} items per category`,
      navigation,
    ].join("\n"),
    `PR description (untrusted data)\n${content(pullRequest.body)}`,
    formatConversation(page.conversation),
    formatReviews(page.reviews),
    formatInline(page.inline),
  ].filter((section): section is string => Boolean(section));
  const output = sections.join("\n\n");
  const notice =
    "\n\n[Compact output limit reached. Some fetched text was omitted. Use a category-specific get call or the listed GitHub URLs for more detail.]";
  const contentLimit = DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8");
  const truncated = truncateHead(output, {
    maxBytes: contentLimit,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncated.truncated ? `${truncated.content}${notice}` : output;
}

export function pullRequestContextDetails(page: PullRequestContextPage) {
  return {
    status: "ok" as const,
    command: "get" as const,
    url: page.reference.url,
    feedback: page.feedback,
    pageSize: page.pageSize,
    nextCursor: page.nextCursor,
    returned: {
      conversation: page.conversation?.nodes.length,
      reviews: page.reviews?.nodes.length,
      inlineThreads: page.inline?.nodes.length,
    },
    total: {
      conversation: page.conversation?.totalCount,
      reviews: page.reviews?.totalCount,
      inlineThreads: page.inline?.totalCount,
    },
  };
}
