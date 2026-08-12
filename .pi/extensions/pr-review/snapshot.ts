import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Exit, PartitionedSemaphore } from "effect";
import { execEffect } from "../_shared/exec";
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

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const snapshotSemaphore = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

function toSnapshotError(message: string, cause?: unknown): SnapshotError {
  return new SnapshotError({ message, cause });
}

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

function fetchAndVerifyEffect(
  exec: Exec,
  repoDir: string,
  remoteSpec: string,
  localRef: string,
  expectedOid: string,
): Effect.Effect<void, SnapshotError> {
  return Effect.gen(function* () {
    yield* runEffect(exec, "git", ["fetch", "--no-tags", "origin", `+${remoteSpec}:${localRef}`], {
      cwd: repoDir,
      timeout: 180000,
    });
    const actual = (yield* runEffect(exec, "git", ["rev-parse", `${localRef}^{commit}`], {
      cwd: repoDir,
    })).stdout.trim();
    if (actual !== expectedOid)
      return yield* toSnapshotError("Fetched ref did not match pull request metadata.");
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

function prepareSnapshotWorkflow(
  exec: Exec,
  cwd: string,
  url: string,
): Effect.Effect<ReviewSnapshot, SnapshotError> {
  const parsed = parsePrUrl(url);
  const key = `${parsed.owner}/${parsed.repo}`;
  return snapshotSemaphore.withPermit(key)(
    Effect.gen(function* () {
      const agentDir = getAgentDir();
      const repoDir = join(agentDir, "pr-review", "repos", parsed.owner, parsed.repo);
      yield* Effect.sync(() => mkdirSync(repoDir, { recursive: true }));
      const metadataRaw = (yield* runEffect(
        exec,
        "gh",
        [
          "pr",
          "view",
          url,
          "--json",
          "url,title,body,baseRefName,baseRefOid,headRefName,headRefOid",
        ],
        { cwd },
      )).stdout;
      const metadata = parseGhJson(metadataRaw, parsed);
      if (!metadata.headOid) return yield* toSnapshotError("Could not resolve PR head commit.");
      if (!metadata.baseRef || !metadata.baseOid)
        return yield* toSnapshotError("Could not resolve PR base branch and commit.");
      yield* runEffect(exec, "git", ["init"], { cwd: repoDir });
      const remote = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      const getUrl = yield* runEffect(exec, "git", ["remote", "get-url", "origin"], {
        cwd: repoDir,
        failOnNonZero: false,
        failureDetail: "git remote get-url origin failed.",
      });
      if (getUrl.code !== 0)
        yield* runEffect(exec, "git", ["remote", "add", "origin", remote], { cwd: repoDir });
      yield* runEffect(exec, "git", ["remote", "set-url", "origin", remote], { cwd: repoDir });

      const headRef = privateRef("head", parsed, metadata.headOid);
      const baseRef = privateRef("base", parsed, metadata.baseRef);
      yield* fetchAndVerifyEffect(
        exec,
        repoDir,
        `refs/pull/${parsed.number}/head`,
        headRef,
        metadata.headOid,
      );
      yield* fetchAndVerifyEffect(
        exec,
        repoDir,
        `refs/heads/${metadata.baseRef}`,
        baseRef,
        metadata.baseOid,
      );

      const mergeBase = (yield* runEffect(
        exec,
        "git",
        ["merge-base", metadata.baseOid, metadata.headOid],
        {
          cwd: repoDir,
        },
      )).stdout.trim();
      const diff = (yield* runEffect(
        exec,
        "git",
        ["diff", "--no-ext-diff", "--no-color", "--find-renames", mergeBase, metadata.headOid],
        { cwd: repoDir, timeout: 180000 },
      )).stdout;
      const manifestRaw = (yield* runEffect(
        exec,
        "git",
        ["diff", "--name-status", "-z", "--find-renames", mergeBase, metadata.headOid],
        { cwd: repoDir, timeout: 180000 },
      )).stdout;
      metadata.changedFiles = parseNameStatusZ(manifestRaw);
      if (!metadata.changedFiles.length) metadata.changedFiles = parseChangedFilesFromDiff(diff);
      const id = makeReviewId(metadata);
      const artifactDir = join(agentDir, "pr-review", "artifacts", id);
      const worktree = join(agentDir, "pr-review", "worktrees", id);
      const diffPath = join(artifactDir, "diff.patch");
      const snapshotEffect = Effect.gen(function* () {
        yield* Effect.sync(() => mkdirSync(artifactDir, { recursive: true }));
        yield* Effect.sync(() => writeFileSync(diffPath, diff));
        yield* runEffect(exec, "git", ["worktree", "add", "--detach", worktree, metadata.headOid], {
          cwd: repoDir,
          timeout: 180000,
        });
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
            : removePathEffect(worktree).pipe(
                Effect.andThen(removePathEffect(artifactDir)),
                Effect.ignoreCause({
                  log: "Warn",
                  message: "PR review cleanup failed after snapshot preparation failed.",
                }),
                Effect.uninterruptible,
              ),
        ),
      );
    }),
  );
}

export function prepareSnapshotEffect(
  exec: Exec,
  cwd: string,
  url: string,
): Effect.Effect<ReviewSnapshot, SnapshotError> {
  return prepareSnapshotWorkflow(exec, cwd, url);
}

export async function prepareSnapshot(
  exec: Exec,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<ReviewSnapshot> {
  const effect = prepareSnapshotEffect(exec, cwd, url);
  return signal ? Effect.runPromise(effect, { signal }) : Effect.runPromise(effect);
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
