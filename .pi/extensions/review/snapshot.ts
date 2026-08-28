import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Exit, PartitionedSemaphore } from "effect";
import { execEffect } from "../_shared/exec";
import {
  ProcessFailure,
  ProcessFailureKind,
  runProcess,
} from "../../../src/process/platform.js";
import {
  makeReviewId,
  parseChangedFilesFromDiff,
  parsePrUrl,
  persistJson,
  sha256,
  type ChangedFile,
  type ReviewMetadata,
  type ReviewSnapshot,
} from "./core";

type Exec = ExtensionAPI["exec"];

export type SnapshotFailureCode =
  | "fetch_failed"
  | "fetch_timeout"
  | "fetched_ref_mismatch"
  | "fetched_ref_missing"
  | "merge_base_missing_ancestry"
  | "shallow_repair_failed"
  | "snapshot_failed";

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  readonly message: string;
  readonly code: SnapshotFailureCode;
  readonly command?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cause?: unknown;
}> {}

const snapshotSemaphore = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

function toSnapshotError(message: string, cause?: unknown): SnapshotError {
  return new SnapshotError({ message, code: "snapshot_failed", cause });
}

function boundedOutput(value?: string): string | undefined {
  if (!value) return undefined;
  return value.length <= 8_000 ? value : value.slice(-8_000);
}

function commandOutput(error: SnapshotError): { stdout?: string; stderr?: string } {
  const cause = error.cause;
  if (cause instanceof ProcessFailure)
    return { stdout: boundedOutput(cause.stdout), stderr: boundedOutput(cause.stderr) };
  return { stdout: boundedOutput(error.stdout), stderr: boundedOutput(error.stderr) };
}

function fetchError(error: SnapshotError, command: string): SnapshotError {
  const timedOut =
    (error.cause instanceof ProcessFailure && error.cause.kind === ProcessFailureKind.Timeout) ||
    /timed?\s*out|timeout/i.test(error.message);
  return new SnapshotError({
    code: timedOut ? "fetch_timeout" : "fetch_failed",
    message: timedOut
      ? `Git fetch timed out: ${command}`
      : `Git fetch failed: ${command}`,
    command,
    ...commandOutput(error),
    cause: error,
  });
}

/** Run Git in an owned process group so interruption and timeout remove all descendants. */
export const managedGitExec: Exec = async (command, args, options = {}) => {
  const effect = runProcess(command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeout,
  });
  const result = options.signal
    ? await Effect.runPromise(effect, { signal: options.signal })
    : await Effect.runPromise(effect);
  return {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    killed: false,
  };
};

let managedGitExecOverride: Exec | undefined;

export function setManagedGitExecForTests(exec?: Exec): void {
  managedGitExecOverride = exec;
}

export const reviewGitExec: Exec = (command, args, options) =>
  (managedGitExecOverride ?? managedGitExec)(command, args, options);

function runEffect(
  exec: Exec,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; failOnNonZero?: boolean; failureDetail?: string } = {},
) {
  return execEffect(exec, command, args, toSnapshotError, options);
}

function run(
  exec: Exec,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
) {
  if (options.signal?.aborted)
    return Promise.reject(toSnapshotError("PR review operation cancelled."));
  const effect = runEffect(exec, command, args, options);
  return options.signal
    ? Effect.runPromise(effect, { signal: options.signal })
    : Effect.runPromise(effect);
}

function parseGhJson(raw: string, fallback: ReturnType<typeof parsePrUrl>): ReviewMetadata {
  const data = JSON.parse(raw || "{}");
  return {
    owner: fallback.owner,
    repo: fallback.repo,
    number: fallback.number,
    url: data.url ?? fallback.url,
    baseRef: data.baseRefName,
    baseOid: data.baseRefOid ?? data.baseRef?.oid ?? "",
    headRef: data.headRefName,
    headOid: data.headRefOid ?? data.headRef?.oid ?? "",
    title: data.title,
    body: data.body,
    changedFiles: [],
  };
}

export async function resolvePrUrl(
  exec: Exec,
  cwd: string,
  requested?: string,
  signal?: AbortSignal,
): Promise<{ url?: string; message?: string }> {
  if (requested) return { url: parsePrUrl(requested).url };
  try {
    const r = await run(exec, "gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
      cwd,
      signal,
    });
    const url = r.stdout.trim();
    return url
      ? { url: parsePrUrl(url).url }
      : {
          message:
            "No pull request is associated with this checkout. Please provide a GitHub PR URL.",
        };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      message:
        "No pull request URL was provided and the current checkout PR could not be resolved. Please provide a GitHub PR URL.",
    };
  }
}

function privateRef(
  prefix: string,
  parsed: ReturnType<typeof parsePrUrl>,
  oidOrName: string,
): string {
  return `refs/pi-pr-review/${prefix}/${parsed.number}/${oidOrName.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function filteredFetchEffect(
  exec: Exec,
  repoDir: string,
  args: string[],
): Effect.Effect<void, SnapshotError> {
  const command = ["git", ...args].join(" ");
  return runEffect(exec, "git", args, {
    cwd: repoDir,
    timeout: 180000,
    failOnNonZero: false,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.void;
      const missingRef = /couldn't find remote ref|not our ref|remote ref does not exist/i.test(
        `${result.stderr}\n${result.stdout}`,
      );
      return Effect.fail(
        new SnapshotError({
          code: missingRef ? "fetched_ref_missing" : "fetch_failed",
          message: missingRef
            ? `Git could not find the requested remote ref: ${command}`
            : `Git fetch exited ${result.code}: ${command}`,
          command,
          stdout: boundedOutput(result.stdout),
          stderr: boundedOutput(result.stderr),
        }),
      );
    }),
    Effect.mapError((error) =>
      error.code === "fetch_failed" || error.code === "fetched_ref_missing"
        ? error
        : fetchError(error, command),
    ),
  );
}

function fetchAndVerifyEffect(
  exec: Exec,
  repoDir: string,
  remoteSpec: string,
  localRef: string,
  expectedOid: string,
): Effect.Effect<void, SnapshotError> {
  return Effect.gen(function* () {
    yield* filteredFetchEffect(exec, repoDir, [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      `+${remoteSpec}:${localRef}`,
    ]);
    const resolved = yield* runEffect(exec, "git", ["rev-parse", `${localRef}^{commit}`], {
      cwd: repoDir,
      failOnNonZero: false,
    });
    if (resolved.code !== 0)
      return yield* new SnapshotError({
        code: "fetched_ref_missing",
        message: `Git fetch completed but the fetched ref is missing: ${localRef}`,
        command: `git rev-parse ${localRef}^{commit}`,
        stdout: resolved.stdout,
        stderr: resolved.stderr,
      });
    const actual = resolved.stdout.trim();
    if (actual !== expectedOid)
      return yield* new SnapshotError({
        code: "fetched_ref_mismatch",
        message: `Fetched ref did not match pull request metadata: ${localRef}`,
        command: `git rev-parse ${localRef}^{commit}`,
        stdout: resolved.stdout,
        stderr: resolved.stderr,
      });
  });
}

function mergeBaseEffect(
  exec: Exec,
  repoDir: string,
  metadata: ReviewMetadata,
  headRemoteSpec: string,
  headRef: string,
  baseRef: string,
): Effect.Effect<string, SnapshotError> {
  return Effect.gen(function* () {
    const mergeBaseArgs = ["merge-base", metadata.baseOid, metadata.headOid];
    let result = yield* runEffect(exec, "git", mergeBaseArgs, {
      cwd: repoDir,
      failOnNonZero: false,
    });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();

    const shallow = yield* runEffect(exec, "git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repoDir,
      failOnNonZero: false,
    });
    if (shallow.code === 0 && shallow.stdout.trim() === "true") {
      const repairArgs = [
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "--unshallow",
        "origin",
        `+${headRemoteSpec}:${headRef}`,
        `+${metadata.baseOid}:${baseRef}`,
      ];
      yield* filteredFetchEffect(exec, repoDir, repairArgs).pipe(
        Effect.catch((error) =>
          error.code === "fetch_timeout"
            ? Effect.fail(error)
            : Effect.fail(
                new SnapshotError({
                  code: "shallow_repair_failed",
                  message: "Git could not restore ancestry in the shallow repository cache.",
                  command: error.command,
                  stdout: error.stdout,
                  stderr: error.stderr,
                  cause: error,
                }),
              ),
        ),
      );
      result = yield* runEffect(exec, "git", mergeBaseArgs, {
        cwd: repoDir,
        failOnNonZero: false,
      });
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
    }

    return yield* new SnapshotError({
      code: "merge_base_missing_ancestry",
      message: "Git could not find common ancestry for the verified pull request refs.",
      command: `git ${mergeBaseArgs.join(" ")}`,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

function parseNameStatusZ(raw: string): ChangedFile[] {
  const fields = raw.split("\0").filter((v) => v.length > 0);
  const out: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      i += 1;
      const next = fields[i++];
      if (next) out.push({ path: next });
      continue;
    }
    const path = fields[i++];
    if (path) out.push({ path });
  }
  return out;
}

function removePathEffect(path: string): Effect.Effect<void> {
  return Effect.sync(() => rmSync(path, { recursive: true, force: true }));
}

function cleanupFailedSnapshotEffect(
  exec: Exec,
  repoDir: string,
  worktree: string,
  artifactDir: string,
): Effect.Effect<void> {
  return runEffect(exec, "git", ["worktree", "remove", "--force", worktree], {
    cwd: repoDir,
    timeout: 120000,
    failOnNonZero: false,
  }).pipe(
    Effect.andThen(
      runEffect(exec, "git", ["worktree", "prune"], {
        cwd: repoDir,
        timeout: 120000,
        failOnNonZero: false,
      }),
    ),
    Effect.ignore,
    Effect.andThen(removePathEffect(worktree)),
    Effect.andThen(removePathEffect(artifactDir)),
    Effect.uninterruptible,
  );
}

function prepareSnapshotWorkflow(
  exec: Exec,
  cwd: string,
  resolvedMetadata: ReviewMetadata,
  reviewId?: string,
  gitExec: Exec = exec,
): Effect.Effect<ReviewSnapshot, SnapshotError> {
  const parsed = parsePrUrl(resolvedMetadata.url);
  const key = `${parsed.owner}/${parsed.repo}`;
  return snapshotSemaphore.withPermit(key)(
    Effect.gen(function* () {
      const metadata = structuredClone(resolvedMetadata);
      const agentDir = getAgentDir();
      const repoDir = join(agentDir, "pr-review", "repos", parsed.owner, parsed.repo);
      yield* Effect.sync(() => {
        mkdirSync(repoDir, { recursive: true, mode: 0o700 });
        chmodSync(repoDir, 0o700);
      });
      if (!metadata.headOid) return yield* toSnapshotError("Could not resolve PR head commit.");
      if (!metadata.baseRef || !metadata.baseOid)
        return yield* toSnapshotError("Could not resolve PR base branch and commit.");
      yield* runEffect(gitExec, "git", ["init"], { cwd: repoDir });
      const remote = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      const getUrl = yield* runEffect(gitExec, "git", ["remote", "get-url", "origin"], {
        cwd: repoDir,
        failOnNonZero: false,
        failureDetail: "git remote get-url origin failed.",
      });
      if (getUrl.code !== 0)
        yield* runEffect(gitExec, "git", ["remote", "add", "origin", remote], { cwd: repoDir });
      yield* runEffect(gitExec, "git", ["remote", "set-url", "origin", remote], { cwd: repoDir });

      const headRef = privateRef("head", parsed, metadata.headOid);
      const baseRef = privateRef("base", parsed, metadata.baseRef);
      const headRemoteSpec = `refs/pull/${parsed.number}/head`;
      yield* fetchAndVerifyEffect(
        gitExec,
        repoDir,
        headRemoteSpec,
        headRef,
        metadata.headOid,
      );
      yield* fetchAndVerifyEffect(gitExec, repoDir, metadata.baseOid, baseRef, metadata.baseOid);

      const mergeBase = yield* mergeBaseEffect(
        gitExec,
        repoDir,
        metadata,
        headRemoteSpec,
        headRef,
        baseRef,
      );
      const diff = (yield* runEffect(
        gitExec,
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--find-renames",
          mergeBase,
          metadata.headOid,
        ],
        { cwd: repoDir, timeout: 180000 },
      )).stdout;
      const manifestRaw = (yield* runEffect(
        gitExec,
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "--find-renames",
          mergeBase,
          metadata.headOid,
        ],
        { cwd: repoDir, timeout: 180000 },
      )).stdout;
      metadata.changedFiles = parseNameStatusZ(manifestRaw);
      if (!metadata.changedFiles.length) metadata.changedFiles = parseChangedFilesFromDiff(diff);
      const id = reviewId ?? makeReviewId(metadata);
      const artifactDir = join(agentDir, "pr-review", "artifacts", id);
      const worktree = join(agentDir, "pr-review", "worktrees", id);
      const diffPath = join(artifactDir, "diff.patch");
      const snapshotEffect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
          chmodSync(artifactDir, 0o700);
        });
        yield* Effect.sync(() => {
          writeFileSync(diffPath, diff, { mode: 0o600 });
          chmodSync(diffPath, 0o600);
        });
        yield* runEffect(gitExec, "git", ["worktree", "add", "--detach", worktree, metadata.headOid], {
          cwd: repoDir,
          timeout: 180000,
        });
        yield* Effect.sync(() => chmodSync(worktree, 0o700));
        const snapshot: ReviewSnapshot = {
          id,
          metadata,
          artifactDir,
          worktree,
          diffPath,
          diffHash: sha256(diff),
          createdAt: new Date().toISOString(),
          cache: { repoDir, worktree },
        };
        yield* Effect.sync(() => persistJson(join(artifactDir, "metadata.json"), snapshot));
        return snapshot;
      });
      return yield* snapshotEffect.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : cleanupFailedSnapshotEffect(gitExec, repoDir, worktree, artifactDir).pipe(
                Effect.ignoreCause({
                  log: "Warn",
                  message: "PR review cleanup failed after snapshot preparation failed.",
                }),
              ),
        ),
      );
    }),
  );
}

export async function resolveReviewMetadata(
  exec: Exec,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<ReviewMetadata> {
  const parsed = parsePrUrl(url);
  const result = await run(
    exec,
    "gh",
    ["pr", "view", url, "--json", "url,title,body,baseRefName,baseRefOid,headRefName,headRefOid"],
    { cwd, signal },
  );
  return parseGhJson(result.stdout, parsed);
}

export function prepareSnapshotEffect(
  exec: Exec,
  cwd: string,
  metadataOrUrl: ReviewMetadata | string,
): Effect.Effect<ReviewSnapshot, SnapshotError> {
  if (typeof metadataOrUrl !== "string") return prepareSnapshotWorkflow(exec, cwd, metadataOrUrl);
  const parsed = parsePrUrl(metadataOrUrl);
  return runEffect(
    exec,
    "gh",
    [
      "pr",
      "view",
      metadataOrUrl,
      "--json",
      "url,title,body,baseRefName,baseRefOid,headRefName,headRefOid",
    ],
    { cwd },
  ).pipe(
    Effect.map((result) => parseGhJson(result.stdout, parsed)),
    Effect.flatMap((metadata) => prepareSnapshotWorkflow(exec, cwd, metadata)),
  );
}

export async function prepareResolvedSnapshot(
  exec: Exec,
  cwd: string,
  metadata: ReviewMetadata,
  signal?: AbortSignal,
  reviewId?: string,
  gitExec?: Exec,
): Promise<ReviewSnapshot> {
  const effect = prepareSnapshotWorkflow(exec, cwd, metadata, reviewId, gitExec);
  return signal ? Effect.runPromise(effect, { signal }) : Effect.runPromise(effect);
}

export async function prepareSnapshot(
  exec: Exec,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<ReviewSnapshot> {
  const metadata = await resolveReviewMetadata(exec, cwd, url, signal);
  return prepareResolvedSnapshot(exec, cwd, metadata, signal);
}

export async function currentRemoteHead(
  exec: Exec,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await run(exec, "gh", ["pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"], {
      cwd,
      signal,
    })
  ).stdout.trim();
}

export async function existingReviewWithMarker(
  exec: Exec,
  cwd: string,
  stateOrUrl: { metadata: ReviewMetadata } | string,
  markerText: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const url = typeof stateOrUrl === "string" ? stateOrUrl : stateOrUrl.metadata.url;
  const parsed = parsePrUrl(url);
  let page = 1;
  for (;;) {
    const r = await run(
      exec,
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews`,
        "-F",
        "per_page=100",
        "-F",
        `page=${page}`,
      ],
      { cwd, signal },
    );
    const reviews = JSON.parse(r.stdout || "[]");
    if (!Array.isArray(reviews) || reviews.length === 0) return undefined;
    const found = reviews.find((review: any) => String(review.body ?? "").includes(markerText));
    if (found?.id !== undefined) return String(found.id);
    if (reviews.length < 100) return undefined;
    page += 1;
  }
}
