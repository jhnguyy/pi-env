import {
  SessionManager,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionScopes } from "../index";

function session(path: string): SessionInfo {
  return {
    id: path,
    path,
    cwd: "/project",
    name: path,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: path,
    allMessagesText: path,
  };
}

function context(sessionFile: string | undefined, sessionDir: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionDir: () => sessionDir,
    },
  } as unknown as ExtensionContext;
}

describe("session resume storage selection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses global default storage for the startup picker", async () => {
    const current = session("/default/current.jsonl");
    const other = session("/default/other.jsonl");
    const list = vi.spyOn(SessionManager, "list").mockResolvedValue([current]);
    const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([current, other]);

    const result = await loadSessionScopes(
      context(undefined, "/sessions/encoded-root"),
      "/project",
      true,
    );

    expect(result).toEqual({ current: [current], all: [current, other] });
    expect(list).toHaveBeenCalledWith("/project");
    expect(listAll).toHaveBeenCalledWith();
  });

  it("uses global default storage for an in-session picker", async () => {
    const current = session("/default/project/current.jsonl");
    const other = session("/default/other-project/other.jsonl");
    const list = vi.spyOn(SessionManager, "list").mockResolvedValue([current]);
    const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([current, other]);

    const result = await loadSessionScopes(
      context(current.path, "/default/project"),
      "/current-project",
      false,
    );

    expect(result).toEqual({ current: [current], all: [current, other] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("/current-project");
    expect(listAll).toHaveBeenCalledWith();
  });

  it("uses the active custom session directory for an in-session picker", async () => {
    const custom = session("/custom/current.jsonl");
    const list = vi
      .spyOn(SessionManager, "list")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([custom]);
    const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([custom]);

    const result = await loadSessionScopes(context(custom.path, "/custom"), "/project", false);

    expect(result).toEqual({ current: [custom], all: [custom] });
    expect(list).toHaveBeenNthCalledWith(1, "/project");
    expect(list).toHaveBeenNthCalledWith(2, "/project", "/custom");
    expect(listAll).toHaveBeenCalledWith("/custom");
  });
});
