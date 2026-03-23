/**
 * PTC extension — unit tests
 *
 * Tests core logic that can be verified without a running pi instance:
 *   - toIdentifier: hyphen→underscore normalisation
 *   - generateWrappers: blocklist filtering, code shape
 *   - buildRpcPreamble: sanity check the generated code
 *   - buildSubprocessCode (via executor internals): structure checks
 */

import { describe, it, expect } from "bun:test";
import { toIdentifier, generateWrappers } from "../wrapper-gen";
import { buildRpcPreamble } from "../rpc-client";
import { BLOCKED_TOOLS, MAX_TOOL_CALLS } from "../types";

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
    const { available } = generateWrappers(SAMPLE_TOOLS);
    const names = available.map((t) => t.name);
    for (const blocked of BLOCKED_TOOLS) {
      expect(names).not.toContain(blocked);
    }
  });

  it("includes non-blocked tools", () => {
    const { available } = generateWrappers(SAMPLE_TOOLS);
    const names = available.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("bash");
    expect(names).toContain("dev-tools");
  });

  it("maps hyphen names to underscore identifiers", () => {
    const { available } = generateWrappers(SAMPLE_TOOLS);
    const devTools = available.find((t) => t.name === "dev-tools");
    expect(devTools?.identifier).toBe("dev_tools");
  });

  it("generates valid async function code for each tool", () => {
    const { code } = generateWrappers(SAMPLE_TOOLS);
    expect(code).toContain("async function read(");
    expect(code).toContain("async function bash(");
    expect(code).toContain("async function dev_tools(");
    // Blocked tools must not appear as function definitions
    expect(code).not.toContain("async function ptc(");
    expect(code).not.toContain("async function orch(");
  });

  it("generated wrappers call __rpc_call with original tool name", () => {
    const { code } = generateWrappers(SAMPLE_TOOLS);
    // dev-tools wrapper must pass the original name "dev-tools" to __rpc_call
    expect(code).toContain(`__rpc_call("dev-tools"`);
  });

  it("generates empty code when all tools are blocked", () => {
    const { code, available } = generateWrappers(
      SAMPLE_TOOLS.filter((t) => BLOCKED_TOOLS.has(t.name)),
    );
    expect(available).toHaveLength(0);
    expect(code.trim()).toBe("");
  });
});

// ─── buildRpcPreamble ─────────────────────────────────────────────────────────

describe("buildRpcPreamble", () => {
  const preamble = buildRpcPreamble();

  it("imports readline", () => {
    expect(preamble).toContain('from "readline"');
  });

  it("defines __rpc_call async function", () => {
    expect(preamble).toContain("async function __rpc_call(");
  });

  it("embeds the MAX_TOOL_CALLS limit", () => {
    expect(preamble).toContain(String(MAX_TOOL_CALLS));
  });

  it("uses process.stdout.write for tool_call messages", () => {
    expect(preamble).toContain("process.stdout.write");
    expect(preamble).toContain('"tool_call"');
  });

  it("reads responses from process.stdin via readline", () => {
    expect(preamble).toContain("process.stdin");
    expect(preamble).toContain('"tool_result"');
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
