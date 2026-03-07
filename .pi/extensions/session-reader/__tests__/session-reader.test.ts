/**
 * Session Reader — unit tests.
 *
 * Tests the pure extraction logic in extractor.ts.
 * No pi API dependencies — all functions are side-effect-free except
 * extractSession (file I/O), which is tested via a temp file.
 */

import { expect, it, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLines, parseTimestamp, extractSession, formatSummary } from "../extractor";
import { describeIfEnabled } from "../../__tests__/test-utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lines(...entries: object[]): string[] {
  return entries.map((e) => JSON.stringify(e));
}

function tempSession(entries: object[]): string {
  const path = join(tmpdir(), `session-reader-test-${Date.now()}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return path;
}

// ─── parseTimestamp ───────────────────────────────────────────────────────────

describeIfEnabled("session-reader", "parseTimestamp", () => {
  it("converts filename datetime to ISO-8601", () => {
    expect(parseTimestamp("2026-03-06T23-15-17-780Z_abc123.jsonl")).toBe(
      "2026-03-06T23:15:17Z",
    );
  });

  it("handles single-digit hour/minute/second", () => {
    expect(parseTimestamp("2026-01-01T01-02-03-000Z_xyz.jsonl")).toBe(
      "2026-01-01T01:02:03Z",
    );
  });
});

// ─── parseLines — user messages ───────────────────────────────────────────────

describeIfEnabled("session-reader", "parseLines — user messages", () => {
  it("extracts text from user messages", () => {
    const result = parseLines(
      lines(
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Second" }] } },
      ),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.userMessages).toEqual(["Hello", "Second"]);
  });

  it("skips user messages with no text content", () => {
    const result = parseLines(
      lines({ type: "message", message: { role: "user", content: [{ type: "image" }] } }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.userMessages).toEqual([]);
  });

  it("trims whitespace from user messages", () => {
    const result = parseLines(
      lines({ type: "message", message: { role: "user", content: [{ type: "text", text: "  trimmed  " }] } }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.userMessages).toEqual(["trimmed"]);
  });
});

// ─── parseLines — agent narrative ────────────────────────────────────────────

describeIfEnabled("session-reader", "parseLines — agent narrative", () => {
  it("extracts text blocks from assistant messages", () => {
    const result = parseLines(
      lines({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will check the file." }],
        },
      }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.agentNarrative).toEqual(["I will check the file."]);
  });

  it("skips tool_use blocks in assistant messages", () => {
    const result = parseLines(
      lines({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running now." },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          ],
        },
      }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.agentNarrative).toEqual(["Running now."]);
  });

  it("does not include tool result content in narrative", () => {
    const result = parseLines(
      lines({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "huge bash output that is noise" }],
        },
      }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.agentNarrative).toEqual([]);
  });
});

// ─── parseLines — tool counts ─────────────────────────────────────────────────

describeIfEnabled("session-reader", "parseLines — tool counts", () => {
  it("counts tool results by tool name", () => {
    const result = parseLines(
      lines(
        { type: "message", message: { role: "toolResult", toolName: "bash", content: [] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", content: [] } },
        { type: "message", message: { role: "toolResult", toolName: "read", content: [] } },
      ),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.toolCounts).toEqual({ bash: 2, read: 1 });
  });

  it("returns empty toolCounts for sessions with no tool calls", () => {
    const result = parseLines(
      lines({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.toolCounts).toEqual({});
  });
});

// ─── parseLines — custom messages ────────────────────────────────────────────

describeIfEnabled("session-reader", "parseLines — custom messages", () => {
  it("extracts custom_message entries with their type and content", () => {
    const result = parseLines(
      lines({
        type: "custom_message",
        customType: "work-tracker",
        content: "[work-tracker] pi-env: main (2 uncommitted)",
        display: false,
      }),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.customMessages).toHaveLength(1);
    expect(result.customMessages[0]).toContain("work-tracker");
    expect(result.customMessages[0]).toContain("pi-env: main");
  });

  it("skips non-custom_message entries", () => {
    const result = parseLines(
      lines(
        { type: "session" },
        { type: "thinking_level_change" },
        { type: "custom", customType: "permissions-session-mode" },
      ),
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.customMessages).toEqual([]);
  });

  it("skips malformed JSON lines without crashing", () => {
    const result = parseLines(
      ["not json at all", JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "ok" }] } })],
      "test.jsonl",
      "2026-03-07T00:00:00Z",
    );
    expect(result.userMessages).toEqual(["ok"]);
  });
});

// ─── extractSession — file I/O ────────────────────────────────────────────────

describeIfEnabled("session-reader", "extractSession", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const p of temps) {
      if (existsSync(p)) unlinkSync(p);
    }
    temps.length = 0;
  });

  it("reads a real file and returns correct filename/timestamp", () => {
    const path = tempSession([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "test" }] } },
    ]);
    temps.push(path);

    const summary = extractSession(path);
    const parts = path.split("/");
    expect(summary.filename).toBe(parts[parts.length - 1]);
    expect(summary.userMessages).toEqual(["test"]);
  });

  it("throws on missing file", () => {
    expect(() => extractSession("/tmp/does-not-exist.jsonl")).toThrow("not found");
  });

  it("throws on non-jsonl extension", () => {
    const path = tempSession([]);
    const wrongExt = path.replace(".jsonl", ".json");
    temps.push(path);
    expect(() => extractSession(wrongExt)).toThrow(".jsonl");
  });
});

// ─── formatSummary ────────────────────────────────────────────────────────────

describeIfEnabled("session-reader", "formatSummary", () => {
  it("includes timestamp header", () => {
    const text = formatSummary({
      filename: "x.jsonl",
      timestamp: "2026-03-07T09:00:00Z",
      userMessages: [],
      agentNarrative: [],
      toolCounts: {},
      customMessages: [],
    });
    expect(text).toContain("2026-03-07T09:00:00Z");
  });

  it("lists tools sorted by count descending", () => {
    const text = formatSummary({
      filename: "x.jsonl",
      timestamp: "2026-03-07T09:00:00Z",
      userMessages: [],
      agentNarrative: [],
      toolCounts: { read: 1, bash: 10, notes: 3 },
      customMessages: [],
    });
    const toolLine = text.split("\n").find((l) => l.startsWith("**Tools:**")) ?? "";
    expect(toolLine.indexOf("bash(10)")).toBeLessThan(toolLine.indexOf("notes(3)"));
    expect(toolLine.indexOf("notes(3)")).toBeLessThan(toolLine.indexOf("read(1)"));
  });

  it("includes user prompts with numbering", () => {
    const text = formatSummary({
      filename: "x.jsonl",
      timestamp: "2026-03-07T09:00:00Z",
      userMessages: ["First prompt", "Second prompt"],
      agentNarrative: [],
      toolCounts: {},
      customMessages: [],
    });
    expect(text).toContain("1. First prompt");
    expect(text).toContain("2. Second prompt");
  });

  it("omits sections that have no content", () => {
    const text = formatSummary({
      filename: "x.jsonl",
      timestamp: "2026-03-07T09:00:00Z",
      userMessages: [],
      agentNarrative: [],
      toolCounts: {},
      customMessages: [],
    });
    expect(text).not.toContain("### User prompts");
    expect(text).not.toContain("### Agent narrative");
    expect(text).not.toContain("### Extension messages");
    expect(text).not.toContain("**Tools:**");
  });
});
