import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  assertContainedResolved,
  marker,
  ReviewEvent,
  type PostAttempt,
  type ReviewSnapshot,
} from "./core";

interface PostingIntent {
  readonly version: 1;
  readonly sessionId: string;
  readonly reviewId: string;
  readonly head: string;
  readonly attempt: PostAttempt;
}

function postingRoot(): string {
  return join(getAgentDir(), "pr-review", "posting");
}

function intentDir(snapshot: ReviewSnapshot): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(snapshot.id) || snapshot.id === "." || snapshot.id === "..")
    throw new Error("Invalid review identity for posting intent.");
  return join(postingRoot(), snapshot.id);
}

// A review can own one remote review. Exclusive creation serializes different
// content hashes across processes as well as attempts within one Pi session.
function intentPath(snapshot: ReviewSnapshot): string {
  return join(intentDir(snapshot), "intent.json");
}

function matchesPostingIntent(
  value: unknown,
  snapshot: ReviewSnapshot,
  sessionId: string,
): value is PostingIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<PostingIntent>;
  const attempt = intent.attempt;
  if (!attempt || typeof attempt !== "object") return false;
  return [
    intent.version === 1,
    intent.sessionId === sessionId,
    intent.reviewId === snapshot.id,
    intent.head === snapshot.metadata.headOid,
    typeof attempt.contentHash === "string" && /^[a-f0-9]{64}$/.test(attempt.contentHash),
    /^[a-f0-9-]{36}$/.test(attempt.id),
    attempt.status === "pending",
    Object.values(ReviewEvent).includes(attempt.event),
    typeof attempt.at === "string" && !Number.isNaN(Date.parse(attempt.at)),
    attempt.reviewId === undefined,
    attempt.marker === marker(snapshot.id, attempt.id),
  ].every(Boolean);
}

export function readPostingIntent(
  snapshot: ReviewSnapshot,
  sessionId: string,
): PostingIntent | undefined {
  const path = intentPath(snapshot);
  if (!existsSync(path)) return undefined;
  assertContainedResolved(join(getAgentDir(), "pr-review"), path);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > 16_384)
    throw new Error("Posting intent is not a bounded regular file.");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!matchesPostingIntent(value, snapshot, sessionId))
    throw new Error("Posting intent does not match the active review. Do not post or clean it up.");
  const { id, event, at, contentHash } = value.attempt;
  return {
    version: 1,
    sessionId,
    reviewId: snapshot.id,
    head: snapshot.metadata.headOid,
    attempt: { id, event, at, contentHash, status: "pending", marker: marker(snapshot.id, id) },
  };
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncIntent(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function prepareIntentDirectory(snapshot: ReviewSnapshot): string {
  const agentDir = getAgentDir();
  const reviewRoot = join(agentDir, "pr-review");
  const root = postingRoot();
  const directory = intentDir(snapshot);
  mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertContainedResolved(reviewRoot, directory);
  // New directory entries must survive along with the final intent file.
  syncDirectory(agentDir);
  syncDirectory(reviewRoot);
  syncDirectory(root);
  return directory;
}

export function recordPostingIntent(
  snapshot: ReviewSnapshot,
  sessionId: string,
  attempt: PostAttempt,
): void {
  if (!attempt.contentHash || !/^[a-f0-9]{64}$/.test(attempt.contentHash))
    throw new Error("Posting attempt has no valid content identity.");
  const directory = prepareIntentDirectory(snapshot);
  const path = intentPath(snapshot);
  if (existsSync(path)) {
    const existing = readPostingIntent(snapshot, sessionId);
    if (existing?.attempt.id !== attempt.id || existing.attempt.contentHash !== attempt.contentHash)
      throw new Error("A different posting attempt already owns this review.");
    // An earlier write may have failed after creating the file. Sync it again.
    syncIntent(path);
    return;
  }
  const payload: PostingIntent = {
    version: 1,
    sessionId,
    reviewId: snapshot.id,
    head: snapshot.metadata.headOid,
    attempt,
  };
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
  if (bytes.length > 16_384) throw new Error("Posting intent exceeds its storage limit.");
  const fd = openSync(path, "wx", 0o600);
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count === 0) throw new Error("Posting intent write was incomplete.");
      written += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(directory);
}

export function hasUnresolvedPostingIntent(
  snapshot: ReviewSnapshot,
  sessionId: string,
  posts: readonly PostAttempt[],
): boolean {
  const directory = intentDir(snapshot);
  if (!existsSync(directory)) return false;
  assertContainedResolved(join(getAgentDir(), "pr-review"), directory);
  // A crash can leave an empty directory or an incomplete file. Neither is
  // proof that a remote POST happened; both require explicit reconciliation.
  const intent = readPostingIntent(snapshot, sessionId);
  if (!intent) return true;
  return !posts.some(
    (post) =>
      post.id === intent.attempt.id &&
      post.marker === intent.attempt.marker &&
      post.status === "posted",
  );
}
