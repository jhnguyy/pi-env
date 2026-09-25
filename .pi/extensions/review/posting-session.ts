import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import {
  parseSessionEntries,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { REVIEW_ENTRY_TYPE, type PostAttempt, type ReviewSnapshot } from "./core";

// Pi buffers a new session until an assistant message exists. A synchronized
// posting intent cannot recover a review whose entire session was never saved.
type ReviewSession = ExtensionContext["sessionManager"];
export interface PostingSessionStorage {
  hasPersistedReviewSession(manager: ReviewSession): boolean;
  syncPersistedPostingEntry(
    manager: ReviewSession,
    snapshot: ReviewSnapshot,
    attempt: PostAttempt,
  ): boolean;
}
const MAX_SESSION_BYTES_FOR_POST = 128 * 1024 * 1024;
export function hasPersistedReviewSession(manager: ReviewSession): boolean {
  const path = manager.getSessionFile();
  return (
    !!path &&
    existsSync(path) &&
    statSync(path).size <= MAX_SESSION_BYTES_FOR_POST &&
    manager
      .getBranch()
      .some((entry) => entry.type === "message" && entry.message.role === "assistant")
  );
}

function syncParents(path: string): void {
  const parents: string[] = [];
  const root = parse(resolve(path)).root;
  for (let dir = dirname(path); dir !== root; dir = dirname(dir)) parents.push(dir);
  for (const dir of parents.reverse()) {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function syncPersistedPostingEntry(
  manager: ReviewSession,
  snapshot: ReviewSnapshot,
  attempt: PostAttempt,
): boolean {
  const path = manager.getSessionFile();
  if (!path || !existsSync(path)) return false;
  // Find the exact active-branch entry, not an abandoned branch with the same marker.
  const active = [...manager.getBranch()].reverse().find((entry) => {
    if (entry.type !== "custom" || entry.customType !== REVIEW_ENTRY_TYPE) return false;
    const data = entry.data as { reviewId?: unknown; state?: { posts?: PostAttempt[] } };
    return (
      data?.reviewId === snapshot.id &&
      data.state?.posts?.some(
        (post) =>
          post.id === attempt.id && post.marker === attempt.marker && post.status === "pending",
      )
    );
  });
  if (!active || active.type !== "custom") return false;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_SESSION_BYTES_FOR_POST) return false;
    const entries = parseSessionEntries(readFileSync(fd, "utf8"));
    if (entries[0]?.type !== "session" || entries[0].id !== manager.getSessionId()) return false;
    const persisted = entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.id === active.id &&
        JSON.stringify(entry.data) === JSON.stringify(active.data),
    );
    if (!persisted) return false;
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The file may contain the entry on an abandoned sibling branch. Reopen
  // Pi's selected leaf rather than trusting membership anywhere in the file.
  const reopened = SessionManager.open(path, manager.getSessionDir(), manager.getCwd());
  if (!reopened.getBranch().some((entry) => entry.id === active.id)) return false;
  const synced = openSync(path, "r");
  try {
    fsyncSync(synced);
  } finally {
    closeSync(synced);
  }
  syncParents(path);
  return true;
}

export const postingSessionStorage: PostingSessionStorage = {
  hasPersistedReviewSession,
  syncPersistedPostingEntry,
};
