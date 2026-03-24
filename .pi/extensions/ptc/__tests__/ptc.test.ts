/**
 * PTC extension — unit tests
 *
 * Tests core logic that can be verified without a running pi instance:
 *   - toIdentifier: hyphen→underscore normalisation
 *   - generateWrappers: blocklist filtering, generated code shape
 *   - subprocess-preamble.ts: key structural checks on the real file
 *   - BLOCKED_TOOLS: blocklist completeness
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { toIdentifier, generateWrappers } from "../wrapper-gen";
import { BLOCKED_TOOLS } from "../types";

// ─── toIdentifier ─────────────────────────────────────────────────────────────

describe("toIdentifier", () => {
  it("leaves snake_case names unchanged", () => {
    expect(toIdentifier("read")).toBe("read");
    expect(toIdentifier("read_pdf")).toBe("read_pdf");
    expect(toIdentifier("proxmox_status")).toBe("proxmox_status");
  });

  it("converts hyphens to underscores", () => {
    expect(toIdentifier("dev-tools")).toBe("dev_tools");
    expect(toIdentifier("some-tool-name")).toBe("some_tool_name");
  });

  it("handles tool names with no special characters", () => {
    expect(toIdentifier("bash")).toBe("bash");
    expect(toIdentifier("todo")).toBe("todo");
  });
});

// ─── generateWrappers ─────────────────────────────────────────────────────────

const SAMPLE_TOOLS = [
  { name: "read",      description: "Read file contents", parameters: {} as any, sourceInfo: {} as any },
  { name: "bash",      description: "Execute bash commands", parameters: {} as any, sourceInfo: {} as any },
  { name: "dev-tools", description: "LSP diagnostics", parameters: {} as any, sourceInfo: {} as any },
  { name: "ptc",       description: "Programmatic tool calling (should be blocked)", parameters: {} as any, sourceInfo: {} as any },
  { name: "orch",      description: "Orchestration (should be blocked)", parameters: {} as any, sourceInfo: {} as any },
  { name: "tmux",      description: "Tmux pane management (should be blocked)", parameters: {} as any, sourceInfo: {} as any },
  { name: "subagent",  description: "Subagent (should be blocked)", parameters: {} as any, sourceInfo: {} as any },
];

describe("generateWrappers", () => {
  it("filters out all blocked tools", () => {
    const code = generateWrappers(SAMPLE_TOOLS);
    for (const blocked of BLOCKED_TOOLS) {
      // Should not appear as a function definition
      expect(code).not.toContain(`async function ${blocked}(`);
      expect(code).not.toContain(`async function ${toIdentifier(blocked)}(`);
    }
  });

  it("generates valid async function code for each non-blocked tool", () => {
    const code = generateWrappers(SAMPLE_TOOLS);
    expect(code).toContain("async function read(");
    expect(code).toContain("async function bash(");
    expect(code).toContain("async function dev_tools(");
  });

  it("generated wrappers call __rpc_call with original tool name", () => {
    const code = generateWrappers(SAMPLE_TOOLS);
    // dev-tools wrapper must use the original hyphenated name for RPC dispatch
    expect(code).toContain(`__rpc_call("dev-tools"`);
  });

  it("returns empty string when all tools are blocked", () => {
    const code = generateWrappers(
      SAMPLE_TOOLS.filter((t) => BLOCKED_TOOLS.has(t.name)),
    );
    expect(code.trim()).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(generateWrappers([]).trim()).toBe("");
  });
});

// ─── subprocess-preamble.ts ───────────────────────────────────────────────────
//
// Verify the real preamble file's structure without importing it (it has side
// effects — sets up readline on process.stdin). Read-as-text checks are enough
// to catch accidental protocol or API breakage.

describe("subprocess-preamble.ts", () => {
  const content = readFileSync(join(import.meta.dir, "../subprocess-preamble.ts"), "utf-8");

  it("exports __rpc_call as an async function", () => {
    expect(content).toContain("export async function __rpc_call(");
  });

  it("imports readline", () => {
    expect(content).toContain('from "readline"');
  });

  it("enforces tool call limit via MAX_TOOL_CALLS", () => {
    expect(content).toContain("MAX_TOOL_CALLS");
  });

  it("writes tool_call messages to process.stdout", () => {
    expect(content).toContain("process.stdout.write");
    expect(content).toContain('"tool_call"');
  });

  it("reads tool_result / tool_error responses from process.stdin", () => {
    expect(content).toContain("process.stdin");
    expect(content).toContain('"tool_result"');
    expect(content).toContain('"tool_error"');
  });
});

// ─── BLOCKED_TOOLS set ────────────────────────────────────────────────────────

describe("BLOCKED_TOOLS", () => {
  it("always blocks ptc itself (prevent recursion)", () => {
    expect(BLOCKED_TOOLS.has("ptc")).toBe(true);
  });

  it("blocks orchestration tools", () => {
    expect(BLOCKED_TOOLS.has("orch")).toBe(true);
    expect(BLOCKED_TOOLS.has("tmux")).toBe(true);
    expect(BLOCKED_TOOLS.has("subagent")).toBe(true);
  });

  it("blocks tools that spawn subagents", () => {
    expect(BLOCKED_TOOLS.has("jit_catch")).toBe(true);
    expect(BLOCKED_TOOLS.has("skill_build")).toBe(true);
  });
});
