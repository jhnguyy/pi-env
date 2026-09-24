import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
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

function intentDir(snapshot: ReviewSnapshot): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(snapshot.id) || snapshot.id === "." || snapshot.id === "..")
    throw new Error("Invalid review identity for posting intent.");
  return join(getAgentDir(), "pr-review", "posting", snapshot.id);
}

function intentPath(snapshot: ReviewSnapshot, contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("Invalid posting content identity.");
  return join(intentDir(snapshot), `${contentHash}.json`);
}

function matchesPostingIntent(
  value: unknown,
  snapshot: ReviewSnapshot,
  sessionId: string,
  contentHash: string,
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
    attempt.contentHash === contentHash,
    /^[a-f0-9-]{36}$/.test(attempt.id),
    attempt.status === "pending",
    Object.values(ReviewEvent).includes(attempt.event),
    attempt.marker === marker(snapshot.id, attempt.id),
  ].every(Boolean);
}

export function readPostingIntent(
  snapshot: ReviewSnapshot,
  sessionId: string,
  contentHash: string,
): PostingIntent | undefined {
  const path = intentPath(snapshot, contentHash);
  if (!existsSync(path)) return undefined;
  assertContainedResolved(join(getAgentDir(), "pr-review"), path);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > 16_384)
    throw new Error("Posting intent is not a bounded regular file.");
  const intent: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!matchesPostingIntent(intent, snapshot, sessionId, contentHash))
    throw new Error("Posting intent does not match the active review. Do not post or clean it up.");
  return intent;
}

export function recordPostingIntent(
  snapshot: ReviewSnapshot,
  sessionId: string,
  attempt: PostAttempt,
): void {
  if (!attempt.contentHash) throw new Error("Posting attempt has no content identity.");
  const path = intentPath(snapshot, attempt.contentHash);
  if (existsSync(path)) {
    const existing = readPostingIntent(snapshot, sessionId, attempt.contentHash);
    if (existing?.attempt.id !== attempt.id)
      throw new Error("A different posting attempt already owns this content.");
    // An earlier write may have failed after creating the file. Sync it again.
    syncIntent(path, intentDir(snapshot));
    return;
  }
  const directory = intentDir(snapshot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertContainedResolved(join(getAgentDir(), "pr-review"), directory);
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
  // Sync the new directory entry as well as the file before allowing a remote POST.
  syncDirectory(directory);
}

function syncDirectory(directory: string): void {
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function syncIntent(path: string, directory: string): void {
  const fd = openSync(path, "r");
  try {
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
  return readdirSync(directory).some((name) => {
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw new Error("Unknown posting intent file. Cleanup is blocked.");
    const intent = readPostingIntent(snapshot, sessionId, name.slice(0, -5));
    return !posts.some(
      (post) =>
        post.id === intent?.attempt.id &&
        post.marker === intent.attempt.marker &&
        post.status === "posted",
    );
  });
}
