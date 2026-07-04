import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  assertUnderSessionDir,
  digestLines,
  formatDigestList,
  formatSessionView,
  inspectLines,
  listSessionDigests,
  parseTimestamp,
} from "../sessions";

function lines(...entries: object[]): string[] {
  return entries.map((entry) => JSON.stringify(entry));
}

describeIfEnabled("introspection", "session timestamp parsing", () => {
  it("converts pi session filenames to readable ISO timestamps", () => {
    expect(parseTimestamp("2026-03-06T23-15-17-780Z_abc123.jsonl")).toBe("2026-03-06T23:15:17Z");
  });
});

describeIfEnabled("introspection", "session digests", () => {
  it("extracts compact navigation metadata without tool output", () => {
    const result = digestLines(
      lines(
        { type: "session", id: "s1", cwd: "/repo" },
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Please fix setup" }] } },
        { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "I'll inspect it" }] } },
        { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "very noisy failure output" }] } },
        { type: "label", targetId: "u1", label: "checkpoint" },
      ),
      "2026-03-06T23-15-17-780Z_abc123.jsonl",
      123,
    );

    expect(result.cwd).toBe("/repo");
    expect(result.firstUserPrompt).toBe("Please fix setup");
    expect(result.toolCounts).toEqual({ bash: 1 });
    expect(result.toolErrors).toBe(1);
    expect(result.labels).toEqual([{ targetId: "u1", label: "checkpoint" }]);
    expect(formatDigestList([result])).not.toContain("very noisy failure output");
  });

  it("surfaces todo labels as milestones in compact lists", () => {
    const result = digestLines(
      lines(
        { type: "session", id: "s1", cwd: "/repo" },
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Do work" }] } },
        { type: "label", targetId: "u1", label: "todo: implement navigation" },
      ),
      "2026-03-06T23-15-17-780Z_abc123.jsonl",
      123,
    );

    const text = formatDigestList([result]);
    expect(text).toContain("1 milestone(s)");
    expect(text).not.toContain("1 label(s)");
  });

  it("skips malformed JSON lines while digesting valid entries", () => {
    const result = digestLines(
      [
        "not json",
        JSON.stringify({ type: "session", id: "s1", cwd: "/repo" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Valid prompt" }] } }),
      ],
      "x.jsonl",
      0,
    );

    expect(result.cwd).toBe("/repo");
    expect(result.firstUserPrompt).toBe("Valid prompt");
  });
});

describeIfEnabled("introspection", "session views", () => {
  it("includes user prompts and tool error summaries while omitting assistant prose", () => {
    const view = inspectLines(
      lines(
        { type: "session", id: "s1", cwd: "/repo" },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Troubleshoot nub" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implemented the fix" }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "nub failed" }] } },
      ),
      "x.jsonl",
      0,
    );

    const text = formatSessionView(view);
    expect(text).toContain("Troubleshoot nub");
    expect(text).toContain("bash: nub failed");
    expect(text).not.toContain("Implemented the fix");
  });

  it("renders todo labels as milestones, separate from labels", () => {
    const view = inspectLines(
      lines(
        { type: "session", id: "s1", cwd: "/repo" },
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Do work" }] } },
        { type: "label", targetId: "u1", label: "todo: implement navigation" },
        { type: "label", targetId: "u1", label: "manual-checkpoint" },
      ),
      "x.jsonl",
      0,
    );

    const text = formatSessionView(view);
    expect(text).toContain("### Milestones");
    expect(text).toContain("implement navigation → u1");
    expect(text).toContain("### Labels");
    expect(text).toContain("manual-checkpoint → u1");
  });
});

describeIfEnabled("introspection", "session directory guard", () => {
  it("accepts files under the configured session directory", () => {
    expect(assertUnderSessionDir("/tmp/sessions/project/a.jsonl", "/tmp/sessions")).toBe("/tmp/sessions/project/a.jsonl");
  });

  it("rejects sibling paths with the same prefix", () => {
    expect(() => assertUnderSessionDir("/tmp/sessions-evil/a.jsonl", "/tmp/sessions")).toThrow("restricted");
  });

  it("rejects the session directory itself", () => {
    expect(() => assertUnderSessionDir("/tmp/sessions", "/tmp/sessions")).toThrow("restricted");
  });
});

describeIfEnabled("introspection", "session listing", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("lists sessions from a session directory and filters by query", () => {
    const root = join(tmpdir(), `introspection-sessions-${Date.now()}`);
    roots.push(root);
    const projectDir = join(root, "--repo--");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "2026-03-06T23-15-17-780Z_abc123.jsonl"),
      lines(
        { type: "session", id: "s1", cwd: "/repo" },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Alpha migration" }] } },
      ).join("\n"),
    );

    const matches = listSessionDigests({ sessionDir: root, query: "alpha", limit: 10 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.firstUserPrompt).toBe("Alpha migration");

    const misses = listSessionDigests({ sessionDir: root, query: "beta", limit: 10 });
    expect(misses).toHaveLength(0);
  });
});
