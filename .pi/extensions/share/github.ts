import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Schema } from "effect";
import * as Exec from "../_shared/exec";

export class ShareError extends Data.TaggedError("ShareError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly mutationOutcome?: "uncertain" | "applied";
}> {}

export function shareFailure(message: string, cause?: unknown): ShareError {
  return new ShareError({ message, cause });
}

export interface ShareTarget {
  readonly repo: RepositoryName;
  readonly branch: string;
  readonly repositoryId: number;
  readonly hasPages: boolean;
}

export function mutationFailure(operation: "upload" | "delete", target: ShareTarget, path: string, outcome: "uncertain" | "applied", cause: unknown): ShareError {
  const destination = `${target.repo}@${target.branch}:${path}`;
  const message = outcome === "applied"
    ? `Uploaded ${destination}, but GitHub did not return a usable view link.`
    : `The ${operation} outcome for ${destination} is uncertain. It may already have completed.`;
  return new ShareError({ message: `${message} Run /share-private list or inspect GitHub before retrying.`, mutationOutcome: outcome, cause });
}

export const RepositoryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/)).pipe(Schema.brand("ShareRepositoryName"));
export type RepositoryName = typeof RepositoryName.Type;
export const SharePath = Schema.String.check(Schema.isPattern(/^sessions\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.html$/)).pipe(Schema.brand("SharePath"));
export type SharePath = typeof SharePath.Type;
const ShareIdentity = Schema.Struct({ name: Schema.String, path: SharePath, sha: Schema.NonEmptyString }).check(
  Schema.makeFilter((file) => file.path === `sessions/${file.name}`),
).pipe(Schema.brand("ShareIdentity"));
export type ShareFile = typeof ShareIdentity.Type & { readonly htmlUrl: string };

type GitHubExec = ExtensionAPI["exec"];
const MaxResponseCharacters = 8 * 1024 * 1024;
const Repository = Schema.Struct({
  id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  private: Schema.Boolean,
  permissions: Schema.Struct({ push: Schema.Boolean }),
  default_branch: Schema.NonEmptyString,
  has_pages: Schema.Boolean,
});
const Branch = Schema.Struct({ name: Schema.NonEmptyString });
const Pages = Schema.Struct({
  public: Schema.Boolean,
  html_url: Schema.String,
  build_type: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    branch: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
  }))),
});
const Content = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  path: Schema.String,
  sha: Schema.NonEmptyString,
  html_url: Schema.NullOr(Schema.String),
});
const Upload = Schema.Struct({ content: Schema.Struct({ html_url: Schema.String }) });

function decode<A>(schema: Schema.Codec<A, unknown>, body: string, description: string) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError((cause) => shareFailure(`GitHub returned an invalid ${description}.`, cause)),
  );
}

// Status comes from the HTTP envelope, never from gh's human-readable stderr.
const request = Effect.fnUntraced(function* (
  exec: GitHubExec, cwd: string, endpoint: string, method = "GET", fields: string[] = [], allowMissing = false,
) {
  const result = yield* Exec.execEffect(exec, "gh", [
    "api", "--hostname", "github.com", "--include", "--method", method, endpoint, ...fields,
  ], shareFailure, { cwd, failOnNonZero: false, failureDetail: "Could not run the GitHub request." });
  if (result.stdout.length > MaxResponseCharacters) {
    return yield* shareFailure("The GitHub response exceeds the share response limit; results may be incomplete.");
  }
  const envelope = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/.exec(result.stdout);
  if (!envelope) return yield* shareFailure("GitHub did not return a valid HTTP response. Check gh authentication and connectivity.");
  const status = Number(envelope[1]);
  if (status === 404 && allowMissing) return undefined;
  if (status < 200 || status >= 300) {
    return yield* shareFailure(`GitHub ${method} ${endpoint} failed (HTTP ${status}). Check repository access and configuration.`);
  }
  if (result.code !== 0) return yield* shareFailure(`GitHub ${method} failed despite HTTP ${status} (exit ${result.code}).`);
  return result.stdout.slice(envelope[0].length);
});

const requiredRequest = Effect.fnUntraced(function* (
  exec: GitHubExec, cwd: string, endpoint: string, method = "GET", fields: string[] = [],
) {
  const body = yield* request(exec, cwd, endpoint, method, fields);
  if (body === undefined) return yield* shareFailure("GitHub returned no response body.");
  return body;
});

function httpsUrl(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
  return url.href;
}

export const inspectTarget = Effect.fnUntraced(function* (
  exec: GitHubExec, cwd: string, repo: RepositoryName, branch?: string,
) {
  const repository = yield* decode(Repository, yield* requiredRequest(exec, cwd, `repos/${repo}`), "repository response");
  if (!Number.isSafeInteger(repository.id) || !repository.private || !repository.permissions.push) {
    return yield* shareFailure("The repository must have a valid identity, be private, and grant your GitHub account push access.");
  }
  const selected = branch ?? repository.default_branch;
  if (!selected || selected.length > 1024 || /[\u0000-\u0020\u007f]/.test(selected) || /[\uD800-\uDFFF]/u.test(selected)) {
    return yield* shareFailure("The share branch is invalid.");
  }
  const current = yield* decode(Branch, yield* requiredRequest(exec, cwd, `repos/${repo}/branches/${encodeURIComponent(selected)}`), "branch response");
  if (current.name !== selected) return yield* shareFailure("GitHub returned a different branch than the selected share branch.");
  return { repo, branch: selected, repositoryId: repository.id, hasPages: repository.has_pages };
});

export const revalidateTarget = Effect.fnUntraced(function* (exec: GitHubExec, cwd: string, target: ShareTarget) {
  const current = yield* inspectTarget(exec, cwd, target.repo, target.branch);
  if (current.repositoryId !== target.repositoryId) {
    return yield* shareFailure("The repository identity changed after confirmation. Confirm the destination again.");
  }
  return current;
});

export const privatePagesBase = Effect.fnUntraced(function* (exec: GitHubExec, cwd: string, target: ShareTarget) {
  if (!target.hasPages) return undefined;
  const pages = yield* decode(Pages, yield* requiredRequest(exec, cwd, `repos/${target.repo}/pages`), "Pages response (private visibility is required)");
  const base = httpsUrl(pages.html_url);
  if (pages.public !== false || !base) {
    return yield* shareFailure("GitHub Pages must be explicitly private and have a valid HTTPS URL before sharing.");
  }
  // Workflow builds do not bind published paths to the configured branch source.
  if (pages.build_type !== "legacy" || pages.source?.branch !== target.branch || pages.source.path !== "/") return undefined;
  return base.endsWith("/") ? base : `${base}/`;
});

export const listShares = Effect.fnUntraced(function* (exec: GitHubExec, cwd: string, target: ShareTarget) {
  const body = yield* request(exec, cwd, `repos/${target.repo}/contents/sessions?ref=${encodeURIComponent(target.branch)}`, "GET", [], true);
  if (body === undefined) {
    const root = yield* decode(Schema.Array(Content), yield* requiredRequest(exec, cwd, `repos/${target.repo}/contents?ref=${encodeURIComponent(target.branch)}`), "repository root contents");
    if (root.length >= 1000 || root.some((entry) => entry.name === "sessions")) {
      return yield* shareFailure("GitHub did not return the sessions directory, and its absence could not be verified. Check branch and contents access.");
    }
    return [];
  }
  const entries = yield* decode(Schema.Array(Content), body, "share directory response");
  if (entries.length >= 1000) {
    return yield* shareFailure("The share directory reached GitHub's 1000-entry Contents limit. The list may be incomplete; manage it in GitHub.");
  }
  const files: ShareFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !Schema.is(ShareIdentity)(entry)) continue;
    const htmlUrl = entry.html_url === null ? undefined : httpsUrl(entry.html_url);
    if (!htmlUrl) return yield* shareFailure("GitHub returned an invalid share view URL.");
    files.push({ ...entry, htmlUrl });
  }
  return files;
});

export const uploadShare = Effect.fnUntraced(function* (
  exec: GitHubExec, cwd: string, target: ShareTarget, path: SharePath, payloadFile: string,
) {
  const response = yield* requiredRequest(exec, cwd, `repos/${target.repo}/contents/${path}`, "PUT", ["--input", payloadFile]).pipe(
    Effect.mapError((cause) => mutationFailure("upload", target, path, "uncertain", cause)),
  );
  const upload = yield* decode(Upload, response, "upload response").pipe(
    Effect.mapError((cause) => mutationFailure("upload", target, path, "applied", cause)),
  );
  const url = httpsUrl(upload.content.html_url);
  if (!url) return yield* mutationFailure("upload", target, path, "applied", undefined);
  return url;
});

export const deleteShare = Effect.fnUntraced(function* (
  exec: GitHubExec, cwd: string, target: ShareTarget, file: ShareFile,
) {
  const endpoint = `repos/${target.repo}/contents/${file.path}`;
  const current = yield* decode(Content, yield* requiredRequest(exec, cwd, `${endpoint}?ref=${encodeURIComponent(target.branch)}`), "current share response");
  if (current.type !== "file" || current.path !== file.path || current.name !== file.name || current.sha !== file.sha) {
    return yield* shareFailure("The selected share changed after listing. List shares again before deleting it.");
  }
  yield* requiredRequest(exec, cwd, endpoint, "DELETE", [
    "-f", `message=Delete shared Pi session ${file.name}`, "-f", `sha=${file.sha}`, "-f", `branch=${target.branch}`,
  ]).pipe(Effect.mapError((cause) => mutationFailure("delete", target, file.path, "uncertain", cause)));
});
