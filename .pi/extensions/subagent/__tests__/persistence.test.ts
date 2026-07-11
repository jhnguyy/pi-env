import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createPersistentSubagentSession,
  getSubagentSessionName,
  hasReachedTurnLimit,
} from "../execute";
import { SubagentJobManager } from "../jobs";

describe("persistent subagent sessions", () => {
  it("names child sessions with a sub- prefix", () => {
    expect(getSubagentSessionName("Recon: Auth Flow")).toBe("sub-recon-auth-flow");
  });

  it("stores a child session beside its parent and links the parent header", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-session-"));
    try {
      const parent = SessionManager.create("/tmp/project", sessionDir);
      const child = createPersistentSubagentSession("audit", {
        cwd: "/tmp/project",
        sessionManager: parent,
      } as any);

      expect(child.file).toBeDefined();
      expect(child.manager.getSessionDir()).toBe(parent.getSessionDir());
      expect(child.manager.getHeader()?.parentSession).toBe(parent.getSessionFile());
      expect(child.manager.getSessionName()).toBe("sub-audit");
      expect(child.manager.getBranch().map((entry) => entry.type)).toEqual([
        "session_info",
        "thinking_level_change",
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("does not impose a turn limit unless the caller selects one", () => {
    expect(hasReachedTurnLimit(1_000, undefined)).toBe(false);
    expect(hasReachedTurnLimit(2, 3)).toBe(false);
    expect(hasReachedTurnLimit(3, 3)).toBe(true);
  });

  it("tracks an asynchronous job through its durable lifecycle entries", async () => {
    const entries: Array<{ customType: string; data: any }> = [];
    const jobs = new SubagentJobManager({
      appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    } as any, new Map(), undefined);
    const job = jobs.start({ name: "invalid", task: "x" }, {
      cwd: "/tmp/project",
      modelRegistry: {},
    } as any);

    expect(job.status === "queued" || job.status === "running").toBe(true);
    await jobs.wait(job.id);
    expect(job.status).toBe("failed");
    expect(entries.map((entry) => entry.data.status)).toEqual(["queued", "running", "failed"]);
  });
});
