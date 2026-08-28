import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSessionTree } from "../tree";

function session(id: string, options: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: options.path ?? `/sessions/${id}.jsonl`,
    parentSessionPath: options.parentSessionPath,
    cwd: options.cwd ?? "/project",
    name: options.name ?? id,
    created: options.created ?? new Date(0),
    modified: options.modified ?? new Date(0),
    messageCount: options.messageCount ?? 1,
    firstMessage: options.firstMessage ?? id,
    allMessagesText: options.allMessagesText ?? id,
  };
}

describe("session resume tree", () => {
  it("keeps orphaned and cyclic sessions visible as roots", () => {
    const orphan = session("orphan", { parentSessionPath: "/sessions/missing.jsonl" });
    const left = session("left", { parentSessionPath: "/sessions/right.jsonl" });
    const right = session("right", { parentSessionPath: left.path });

    expect(
      buildSessionTree([orphan, left, right])
        .map((node) => node.path)
        .sort(),
    ).toEqual([left.path, orphan.path, right.path].sort());
  });
});
