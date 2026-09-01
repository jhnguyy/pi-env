import { describe, expect, it } from "vitest";
import {
  SEARCH_TOOL_NAME,
  expandEntries,
  expandRequestedEntries,
  latestStateFromEntries,
  profileTools,
  resolveConfig,
  searchTools,
  setAdditive,
  triggerGroups,
} from "../core";

const tools = ["read", "bash", "edit", "write", "dev-tools", "ptc", SEARCH_TOOL_NAME, "analyze", "subagent", "jit_catch", "review", "web_fetch", "notes", "linear"].map((name) => ({ name, description: name === "notes" ? "team notes forgejo" : name, parameters: {}, sourceInfo: { source: "x" } as any }));

describe("tool manager core", () => {
  it("uses the core profile after all tools are known and rejects an invalid configured default", () => {
    expect(profileTools("core", resolveConfig(), tools)).toEqual(["read", "bash", "edit", "write", "dev-tools", "ptc", SEARCH_TOOL_NAME]);
    expect(resolveConfig({ defaultProfile: "missing" }).defaultProfile).toBe("core");
  });

  it("expands requested names without forcing alwaysActive into removal inputs", () => {
    const cfg = resolveConfig({ alwaysActive: ["notes"] });
    expect(expandRequestedEntries(["analysis"], cfg, tools)).toEqual(["analyze"]);
    expect(expandEntries(["analysis"], cfg, tools)).toEqual(["analyze", SEARCH_TOOL_NAME, "notes"]);
    expect(setAdditive(["read"], expandRequestedEntries(["analysis"], cfg, tools), cfg, tools)).toContain("notes");
    expect(setAdditive(["read", SEARCH_TOOL_NAME, "notes"], [], cfg, tools)).toEqual(["read", SEARCH_TOOL_NAME, "notes"]);
  });

  it("search is reliable and respects manual-only", () => {
    const manual = resolveConfig({ manualOnly: ["notes"] });
    expect(searchTools("bounded complexity loads analysis", ["read"], resolveConfig(), tools).loaded).toEqual(["analyze"]);
    expect(searchTools("notes", ["read"], resolveConfig(), tools).loaded).toEqual(["notes"]);
    expect(searchTools("forgejo", ["read"], resolveConfig(), tools).loaded).toEqual([]);
    expect(searchTools("notes", ["read"], manual, tools).loaded).toEqual([]);
    expect(searchTools("linear issue", ["read"], resolveConfig(), tools).loaded).toEqual(["linear"]);
  });

  it("trigger matrix auto-activates analysis for coding sessions with code entities", () => {
    expect(triggerGroups({ text: "fix this TypeScript file" }, true)).toContain("analysis");
    expect(triggerGroups({ text: "analyze this design" }, true)).not.toContain("analysis");
    expect(triggerGroups({ text: "delegate this to subagent in background" }, true)).toContain("delegation");
    expect(triggerGroups({ text: "create a skill for this" }, true)).toContain("skills");
    expect(triggerGroups({ text: "use catching for JIT phrasing" }, true)).toContain("catching-tests");
    expect(triggerGroups({ text: "read previous session conversation" }, true)).toContain("sessions");
    expect(triggerGroups({ text: "Review this PR https://github.com/acme/widgets/pull/123" }, true)).toContain("review");
    expect(triggerGroups({ text: "Review this pull request" }, true)).toContain("review");
    expect(triggerGroups({ text: "Perform a PR review" }, true)).toContain("review");
    expect(triggerGroups({ text: "Address feedback on this PR" }, true)).toContain("review");
    expect(triggerGroups({ text: "Get comments from https://github.com/acme/widgets/pull/123" }, true)).toContain("review");
    expect(triggerGroups({ text: "address this feedback" }, true)).not.toContain("review");
    expect(triggerGroups({ text: "review this TypeScript file" }, true)).not.toContain("review");
    expect(triggerGroups({ text: "fetch https://example.com" }, true)).toContain("web");
    expect(triggerGroups({ text: "run extension tests" }, true)).not.toContain("catching-tests");
    expect(triggerGroups({ text: "fetch https://example.com", source: "extension" }, true)).toEqual([]);
    expect(triggerGroups({ text: "find the Linear issue for this work" }, true)).toContain("linear-read");
  });

  it("does not advertise unavailable Linear write tools", () => {
    const config = resolveConfig();
    expect(config.groups).not.toHaveProperty("linear-write");
    expect(config.manualOnly).toEqual(new Set());
    expect(profileTools("full", config, tools).filter((name) => name.startsWith("linear"))).toEqual(["linear"]);
  });

  it("restores latest branch entry and filters missing tools", () => {
    const latest = latestStateFromEntries([{ customType: "tool-manager:state", data: { active: ["missing", "read"], reason: "toggle", at: "a" } }]);
    expect(latest?.active).toEqual(["missing", "read"]);
    expect(setAdditive([], latest?.active ?? [], resolveConfig(), tools)).toEqual(["read", SEARCH_TOOL_NAME]);
  });
});
