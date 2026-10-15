import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createPersistentSubagentSession } from "../execute";
import { SubagentSessionStorage } from "../config";

describe("persistent subagent sessions", () => {
  it("stores a named child below its parent session ID and preserves its linked transcript", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-session-"));
    try {
      const parent = SessionManager.create("/tmp/project", sessionDir);
      const child = createPersistentSubagentSession("Recon: Auth Flow", {
        cwd: "/tmp/project",
        sessionManager: parent,
      } as any);

      expect(child.file).toBeDefined();
      expect(child.manager.getSessionDir()).toBe(
        join(parent.getSessionDir(), "_children", parent.getSessionId()),
      );
      expect(child.manager.getHeader()?.parentSession).toBe(parent.getSessionFile());
      expect(child.manager.getSessionName()).toBe("sub-recon-auth-flow");
      expect(child.manager.getBranch().map((entry) => entry.type)).toEqual([
        "session_info",
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps nested children out of native discovery while exact-path resume remains available", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-native-discovery-"));
    try {
      const parent = SessionManager.create("/tmp/project", sessionDir);
      parent.appendSessionInfo("parent");
      parent.appendMessage({ role: "user", content: "parent prompt", timestamp: Date.now() } as any);
      parent.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "parent response" }],
        timestamp: Date.now(),
      } as any);
      const child = createPersistentSubagentSession("audit", {
        cwd: "/tmp/project",
        sessionManager: parent,
      } as any);
      child.manager.appendMessage({
        role: "user",
        content: "child prompt",
        timestamp: Date.now(),
      } as any);
      child.manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "child response" }],
        timestamp: Date.now(),
      } as any);

      const currentPaths = (await SessionManager.list("/tmp/project", sessionDir)).map(
        (session) => session.path,
      );
      const allPaths = (await SessionManager.listAll(sessionDir)).map((session) => session.path);

      expect(currentPaths).toContain(parent.getSessionFile());
      expect(currentPaths).not.toContain(child.file);
      expect(allPaths).not.toContain(child.file);

      const reopened = SessionManager.open(child.file!);
      expect(reopened.getSessionId()).toBe(child.id);
      expect(reopened.getHeader()?.parentSession).toBe(parent.getSessionFile());
      expect(reopened.getSessionName()).toBe("sub-audit");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps an imported parent ID inside the nested child root", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-parent-id-"));
    try {
      const nestedRoot = join(sessionDir, "_children");
      const child = createPersistentSubagentSession("audit", {
        cwd: "/tmp/project",
        sessionManager: {
          getSessionDir: () => sessionDir,
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
          getSessionId: () => `../../outside-${"x".repeat(500)}`,
        },
      } as any);

      expect(relative(nestedRoot, child.manager.getSessionDir())).not.toMatch(/^\.\.(?:\/|$)/);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("uses native default storage when the parent session is in memory", () => {
    const child = createPersistentSubagentSession("audit", {
      cwd: "/tmp/project",
      sessionManager: SessionManager.inMemory("/tmp/project"),
    } as any);
    const nativeDefault = SessionManager.create("/tmp/project");

    expect(child.manager.getSessionDir()).toBe(nativeDefault.getSessionDir());
  });

  it("supports sibling storage as an explicit compatibility mode", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-sibling-session-"));
    try {
      const parent = SessionManager.create("/tmp/project", sessionDir);
      const child = createPersistentSubagentSession(
        "audit",
        { cwd: "/tmp/project", sessionManager: parent } as any,
        "/tmp/project",
        SubagentSessionStorage.Sibling,
      );

      expect(child.manager.getSessionDir()).toBe(parent.getSessionDir());
      expect(child.manager.getHeader()?.parentSession).toBe(parent.getSessionFile());
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });


});
