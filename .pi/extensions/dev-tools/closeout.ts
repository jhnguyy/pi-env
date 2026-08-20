import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Schema } from "effect";
import { Type, type Static } from "typebox";
import { execEffect } from "../_shared/exec";
import { parseWorktreePorcelain, type WorktreeEntry } from "./cleanup-core";

type Exec = ExtensionAPI["exec"];

export interface CloseoutRequest {
  readonly pr?: string;
  readonly repoPath?: string;
}

export interface CloseoutResult {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly baseBranch: string;
  readonly baseOid: string;
  readonly headBranch: string;
  readonly removedWorktree?: string;
  readonly deletedBranch: boolean;
}

export class CloseoutError extends Data.TaggedError("CloseoutError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PullRequestSchema = Schema.Struct({
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  url: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
});

type PullRequest = typeof PullRequestSchema.Type;

const CloseoutToolParameters = Type.Object({
  pr: Type.Optional(
    Type.String({
      description: "GitHub pull request number or URL. Omit to resolve the current checkout.",
    }),
  ),
  repo: Type.Optional(
    Type.String({ description: "Local repository path. Defaults to the Pi working directory." }),
  ),
});
type CloseoutToolInput = Static<typeof CloseoutToolParameters>;

const githubName = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?";
const pullRequestUrlPattern = new RegExp(
  `^https://github\\.com/(${githubName})/(${githubName})/pull/([1-9][0-9]{0,9})(?:[/?#].*)?$`,
);
const protectedBranches = new Set(["main", "master", "develop", "dev", "prod", "production"]);

interface ParsedPullRequestUrl {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

export function parseCloseoutArgs(args: string | undefined): CloseoutRequest {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  let pr: string | undefined;
  let repoPath: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--repo") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--repo requires a path.");
      repoPath = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--repo=")) {
      repoPath = token.slice("--repo=".length);
      if (!repoPath) throw new Error("--repo requires a path.");
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown closeout option: ${token}`);
    if (pr) throw new Error("Closeout accepts one PR number or GitHub PR URL.");
    pr = normalizePullRequestReference(token);
  }

  return { pr, repoPath };
}

function normalizePullRequestReference(value: string): string {
  if (/^[1-9][0-9]{0,9}$/.test(value)) return value;
  const parsed = parsePullRequestUrl(value);
  if (parsed) return parsed.url;
  throw new Error("Expected a PR number or GitHub PR URL.");
}

function parsePullRequestUrl(value: string): ParsedPullRequestUrl | undefined {
  const match = value.match(pullRequestUrlPattern);
  if (!match) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}

function closeoutFailure(message: string, cause?: unknown): CloseoutError {
  return new CloseoutError({ message, cause });
}

function run(
  exec: Exec,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; failOnNonZero?: boolean } = {},
) {
  return execEffect(exec, command, args, closeoutFailure, options);
}

function decodePullRequest(raw: string): Effect.Effect<PullRequest, CloseoutError> {
  return Effect.try({
    try: () => JSON.parse(raw || "{}") as unknown,
    catch: (cause) => closeoutFailure("GitHub returned invalid pull request JSON.", cause),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(PullRequestSchema)(value)),
    Effect.mapError((cause) =>
      cause instanceof CloseoutError
        ? cause
        : closeoutFailure("GitHub returned incomplete pull request metadata.", cause),
    ),
  );
}

function loadPullRequest(
  exec: Exec,
  cwd: string,
  requested: string | undefined,
): Effect.Effect<PullRequest, CloseoutError> {
  const args = ["pr", "view"];
  if (requested) args.push(requested);
  args.push(
    "--json",
    "state,mergedAt,mergeCommit,url,headRefName,headRefOid,baseRefName,isCrossRepository",
  );
  return run(exec, "gh", args, { cwd }).pipe(
    Effect.flatMap((result) => decodePullRequest(result.stdout)),
  );
}

function gitText(
  exec: Exec,
  cwd: string,
  args: string[],
  timeout?: number,
): Effect.Effect<string, CloseoutError> {
  return run(exec, "git", args, { cwd, timeout }).pipe(
    Effect.map((result) => result.stdout.trim()),
  );
}

function gitExit(exec: Exec, cwd: string, args: string[]) {
  return run(exec, "git", args, { cwd, failOnNonZero: false }).pipe(
    Effect.map((result) => result.code),
  );
}

function ensure(condition: boolean, message: string): Effect.Effect<void, CloseoutError> {
  return condition ? Effect.void : Effect.fail(closeoutFailure(message));
}

interface GitRemoteRepository {
  readonly host: string;
  readonly repository: string;
  readonly resolvesSshAlias: boolean;
}

function normalizeRepositoryPath(value: string): string | undefined {
  const path = value.replace(/^\//, "").replace(/\.git$/, "");
  return /^[^/]+\/[^/]+$/.test(path) ? path.toLowerCase() : undefined;
}

function parseGitRemoteRepository(value: string): GitRemoteRepository | undefined {
  const trimmed = value.trim();
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      const repository = normalizeRepositoryPath(url.pathname);
      if (!repository) return undefined;
      const protocol = url.protocol.toLowerCase();
      return {
        host: url.hostname.toLowerCase(),
        repository,
        resolvesSshAlias: protocol === "ssh:" || protocol === "git+ssh:",
      };
    } catch {
      return undefined;
    }
  }
  const scp = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (!scp) return undefined;
  const repository = normalizeRepositoryPath(scp[2]!);
  return repository
    ? { host: scp[1]!.toLowerCase(), repository, resolvesSshAlias: true }
    : undefined;
}

function sshConfigHostname(raw: string): string | undefined {
  return raw
    .split("\n")
    .map((line) => line.trim().match(/^hostname\s+(\S+)$/i)?.[1])
    .find((hostname) => Boolean(hostname))
    ?.toLowerCase();
}

function githubRepositoryFromRemote(
  exec: Exec,
  cwd: string,
  value: string,
): Effect.Effect<string | void, CloseoutError> {
  const remote = parseGitRemoteRepository(value);
  if (!remote) return Effect.void;
  if (remote.host === "github.com") return Effect.succeed(remote.repository);
  if (!remote.resolvesSshAlias) return Effect.void;
  return run(exec, "ssh", ["-G", "--", remote.host], {
    cwd,
    failOnNonZero: false,
  }).pipe(
    Effect.map((result) =>
      result.code === 0 && sshConfigHostname(result.stdout) === "github.com"
        ? remote.repository
        : undefined,
    ),
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathContains(root: string, candidate: string): boolean {
  const path = relative(canonicalPath(root), canonicalPath(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function findWorktree(worktrees: WorktreeEntry[], branch: string): WorktreeEntry | undefined {
  return worktrees.find((entry) => entry.branch === branch);
}

function isProtectedBranch(branch: string): boolean {
  return protectedBranches.has(branch) || branch.startsWith("release/");
}

function isDirty(exec: Exec, cwd: string): Effect.Effect<boolean, CloseoutError> {
  return gitText(exec, cwd, ["status", "--porcelain"]).pipe(
    Effect.map((status) => status.length > 0),
  );
}

function verifyWorktree(
  exec: Exec,
  worktree: WorktreeEntry,
  expectedBranch: string,
  label: string,
): Effect.Effect<void, CloseoutError> {
  return Effect.gen(function* () {
    const exists = yield* Effect.sync(() => existsSync(worktree.path));
    yield* ensure(exists, `${label} worktree is missing: ${worktree.path}`);
    const branch = yield* gitText(exec, worktree.path, ["branch", "--show-current"]);
    yield* ensure(
      branch === expectedBranch,
      `${label} worktree is not on branch ${expectedBranch}: ${worktree.path}`,
    );
    const dirty = yield* isDirty(exec, worktree.path);
    yield* ensure(!dirty, `${label} worktree has uncommitted changes: ${worktree.path}`);
  });
}

function verifyLocalHead(
  exec: Exec,
  cwd: string,
  branch: string,
  expectedOid: string,
): Effect.Effect<void, CloseoutError> {
  return gitText(exec, cwd, ["rev-parse", `refs/heads/${branch}^{commit}`]).pipe(
    Effect.flatMap((oid) =>
      ensure(oid === expectedOid, `Local branch ${branch} does not match the merged PR head.`),
    ),
  );
}

function closeoutWorkflow(
  exec: Exec,
  cwd: string,
  request: CloseoutRequest,
): Effect.Effect<CloseoutResult, CloseoutError> {
  return Effect.gen(function* () {
    const lookupCwd = request.repoPath ? resolve(cwd, request.repoPath) : cwd;
    const pr = yield* loadPullRequest(exec, lookupCwd, request.pr);
    const parsedUrl = parsePullRequestUrl(pr.url);
    yield* ensure(Boolean(parsedUrl), "GitHub returned an invalid pull request URL.");
    yield* ensure(
      pr.state === "MERGED" && Boolean(pr.mergedAt) && Boolean(pr.mergeCommit?.oid),
      `Pull request ${pr.url} is not merged.`,
    );
    yield* ensure(
      !pr.isCrossRepository,
      "Closeout does not delete local branches for fork pull requests.",
    );
    yield* ensure(pr.headRefName !== pr.baseRefName, "The PR head branch matches its base branch.");
    yield* ensure(
      !isProtectedBranch(pr.headRefName),
      `Refusing to delete protected branch ${pr.headRefName}.`,
    );

    const repoRoot = yield* gitText(exec, lookupCwd, ["rev-parse", "--show-toplevel"]);
    const originUrl = yield* gitText(exec, repoRoot, ["remote", "get-url", "origin"]);
    const localRepository = yield* githubRepositoryFromRemote(exec, repoRoot, originUrl);
    const expectedRepository = `${parsedUrl!.owner}/${parsedUrl!.repo}`.toLowerCase();
    yield* ensure(
      localRepository === expectedRepository,
      `Pull request ${pr.url} does not belong to the local origin repository.`,
    );

    const worktrees = parseWorktreePorcelain(
      yield* gitText(exec, repoRoot, ["worktree", "list", "--porcelain"]),
    );
    const baseWorktree = findWorktree(worktrees, pr.baseRefName);
    const headWorktree = findWorktree(worktrees, pr.headRefName);
    yield* ensure(Boolean(baseWorktree), `Base branch ${pr.baseRefName} has no local worktree.`);
    if (headWorktree) {
      yield* ensure(
        !worktrees[0] || !samePath(headWorktree.path, worktrees[0].path),
        `Refusing to remove the repository's primary worktree: ${headWorktree.path}`,
      );
      yield* ensure(
        !pathContains(headWorktree.path, cwd),
        `Refusing to remove the worktree that contains the current Pi working directory: ${headWorktree.path}`,
      );
      yield* verifyWorktree(exec, headWorktree, pr.headRefName, "PR head");
    }
    yield* verifyWorktree(exec, baseWorktree!, pr.baseRefName, "Base branch");

    const localHeadRef = `refs/heads/${pr.headRefName}`;
    const localHeadExists =
      (yield* gitExit(exec, baseWorktree!.path, [
        "show-ref",
        "--verify",
        "--quiet",
        localHeadRef,
      ])) === 0;
    if (headWorktree) {
      yield* ensure(localHeadExists, `Local branch ${pr.headRefName} is missing.`);
    }
    if (localHeadExists) {
      yield* verifyLocalHead(exec, baseWorktree!.path, pr.headRefName, pr.headRefOid);
    }

    const remoteUrl = `https://github.com/${parsedUrl!.owner}/${parsedUrl!.repo}.git`;
    yield* run(
      exec,
      "git",
      ["fetch", "--prune", "--no-tags", remoteUrl, "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: baseWorktree!.path, timeout: 180_000 },
    );

    const localBaseRef = `refs/heads/${pr.baseRefName}`;
    const remoteBaseRef = `refs/remotes/origin/${pr.baseRefName}`;
    yield* ensure(
      (yield* gitExit(exec, baseWorktree!.path, [
        "show-ref",
        "--verify",
        "--quiet",
        localBaseRef,
      ])) === 0,
      `Local base branch ${pr.baseRefName} is missing.`,
    );
    yield* ensure(
      (yield* gitExit(exec, baseWorktree!.path, [
        "show-ref",
        "--verify",
        "--quiet",
        remoteBaseRef,
      ])) === 0,
      `Remote base branch origin/${pr.baseRefName} is missing after fetch.`,
    );
    yield* ensure(
      (yield* gitExit(exec, baseWorktree!.path, [
        "merge-base",
        "--is-ancestor",
        localBaseRef,
        remoteBaseRef,
      ])) === 0,
      `Local base branch ${pr.baseRefName} cannot fast-forward to origin/${pr.baseRefName}.`,
    );
    yield* ensure(
      (yield* gitExit(exec, baseWorktree!.path, [
        "merge-base",
        "--is-ancestor",
        pr.mergeCommit!.oid,
        remoteBaseRef,
      ])) === 0,
      `The merged PR commit is not present on origin/${pr.baseRefName}.`,
    );

    if (headWorktree) yield* verifyWorktree(exec, headWorktree, pr.headRefName, "PR head");
    yield* verifyWorktree(exec, baseWorktree!, pr.baseRefName, "Base branch");
    if (localHeadExists) {
      yield* verifyLocalHead(exec, baseWorktree!.path, pr.headRefName, pr.headRefOid);
    }
    yield* run(exec, "git", ["merge", "--ff-only", remoteBaseRef], {
      cwd: baseWorktree!.path,
      timeout: 120_000,
    });
    const baseOid = yield* gitText(exec, baseWorktree!.path, ["rev-parse", "HEAD"]);

    if (headWorktree) {
      yield* run(exec, "git", ["worktree", "remove", headWorktree.path], {
        cwd: baseWorktree!.path,
        timeout: 30_000,
      });
    }

    let deletedBranch = false;
    if (localHeadExists) {
      yield* run(exec, "git", ["update-ref", "-d", localHeadRef, pr.headRefOid], {
        cwd: baseWorktree!.path,
        timeout: 30_000,
      });
      deletedBranch = true;
    }

    return {
      prNumber: parsedUrl!.number,
      prUrl: parsedUrl!.url,
      baseBranch: pr.baseRefName,
      baseOid,
      headBranch: pr.headRefName,
      removedWorktree: headWorktree?.path,
      deletedBranch,
    };
  });
}

export function closeoutPullRequest(
  exec: Exec,
  cwd: string,
  request: CloseoutRequest,
  signal?: AbortSignal,
): Promise<CloseoutResult> {
  const workflow = closeoutWorkflow(exec, cwd, request);
  return signal ? Effect.runPromise(workflow, { signal }) : Effect.runPromise(workflow);
}

export function formatCloseoutResult(result: CloseoutResult): string {
  const worktree = result.removedWorktree
    ? `Removed worktree ${result.removedWorktree}.`
    : "The head worktree was already absent.";
  const branch = result.deletedBranch
    ? `Deleted local branch ${result.headBranch}.`
    : `Local branch ${result.headBranch} was already absent.`;
  return [
    `Closed out ${result.prUrl}.`,
    `Fast-forwarded ${result.baseBranch} to ${result.baseOid.slice(0, 12)}.`,
    worktree,
    branch,
  ].join("\n");
}

export function registerCloseout(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "closeout",
    label: "Close Out Pull Request",
    description:
      "Verify and close out one merged GitHub pull request. Synchronizes its base branch, removes only its head worktree, and deletes its matching local branch.",
    promptSnippet:
      "Close out a verified merged GitHub pull request and clean up its local worktree and branch",
    promptGuidelines: [
      "Use closeout only after the user explicitly confirms that the pull request is merged and requests cleanup.",
    ],
    parameters: CloseoutToolParameters,
    async execute(_toolCallId, params: CloseoutToolInput, signal, _onUpdate, ctx) {
      const result = await closeoutPullRequest(
        pi.exec.bind(pi),
        ctx.cwd,
        {
          pr: params.pr ? normalizePullRequestReference(params.pr) : undefined,
          repoPath: params.repo,
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatCloseoutResult(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("closeout", {
    description:
      "Close out one merged GitHub pull request without an LLM. Usage: /closeout [PR number-or-URL] [--repo <path>]. The repository defaults to the Pi working directory.",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const result = await closeoutPullRequest(
          pi.exec.bind(pi),
          ctx.cwd,
          parseCloseoutArgs(args),
        );
        ctx.ui.notify(formatCloseoutResult(result), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Closeout failed: ${message}`, "error");
      }
    },
  });
}
