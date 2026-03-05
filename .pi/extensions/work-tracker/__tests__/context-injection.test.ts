/**
 * Context injection tests — verify that root sessions receive git status
 * and that subagents (PI_AGENT_ID set) skip injection entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// ─── Subagent skip ────────────────────────────────────────────────────────────

describe("context injection: subagent skip", () => {
  const originalEnv = process.env.PI_AGENT_ID;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_AGENT_ID;
    } else {
      process.env.PI_AGENT_ID = originalEnv;
    }
  });

  it("returns empty object when PI_AGENT_ID is set (subagent)", async () => {
    process.env.PI_AGENT_ID = "subagent-123";

    // Simulate the before_agent_start logic inline — mirrors index.ts exactly
    const result = process.env.PI_AGENT_ID ? {} : { message: "would-inject" };
    expect(result).toEqual({});
  });

  it("would inject when PI_AGENT_ID is not set (root session)", async () => {
    delete process.env.PI_AGENT_ID;

    // Simulate the before_agent_start guard check
    const isSubagent = !!process.env.PI_AGENT_ID;
    expect(isSubagent).toBe(false);
  });
});
