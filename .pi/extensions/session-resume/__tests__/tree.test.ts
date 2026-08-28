import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSessionTree, flattenVisibleSessions, searchSessions } from "../tree";

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
  it("starts with roots collapsed and reveals only expanded descendants", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", { parentSessionPath: child.path });
    const roots = buildSessionTree([parent, child, grandchild]);

    expect(flattenVisibleSessions(roots, new Set()).map((node) => node.path)).toEqual([
      parent.path,
    ]);
    expect(flattenVisibleSessions(roots, new Set([parent.path])).map((node) => node.path)).toEqual([
      parent.path,
      child.path,
    ]);
    expect(
      flattenVisibleSessions(roots, new Set([parent.path, child.path])).map((node) => node.path),
    ).toEqual([parent.path, child.path, grandchild.path]);
  });

  it("orders roots by the latest activity in each subtree", () => {
    const olderParent = session("older-parent", { modified: new Date("2026-01-01") });
    const activeParent = session("active-parent", { modified: new Date("2025-01-01") });
    const activeChild = session("active-child", {
      parentSessionPath: activeParent.path,
      modified: new Date("2026-02-01"),
    });

    expect(
      buildSessionTree([olderParent, activeParent, activeChild]).map((node) => node.path),
    ).toEqual([activeParent.path, olderParent.path]);
  });

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

  it("searches collapsed descendants without tree indentation", () => {
    const parent = session("parent");
    const child = session("child", { name: "Unique child", parentSessionPath: parent.path });

    const matches = searchSessions([parent, child], "unique child");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: child.path, depth: 0, hasChildren: false });
  });
});
