import { parseDagSubagentPayload } from "../../../../src/dag/index.js";
import { describe, expect, it } from "vitest";
import {
  buildPiSessionEvidence,
  compilePiSessionReviewGraph,
  formatPiSessionReview,
  pagePiSessionEvidence,
} from "../pi-session-review";

describe("Pi session review evidence", () => {
  it("normalizes the active branch and redacts sensitive tool arguments", () => {
    const evidence = buildPiSessionEvidence({
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      cwd: "/workspace",
      leafId: "leaf",
      entries: [
        {
          type: "message",
          id: "user-1",
          timestamp: "2026-08-24T00:00:00Z",
          message: { role: "user", content: "Inspect the parser" },
        },
        {
          type: "message",
          id: "assistant-1",
          timestamp: "2026-08-24T00:00:01Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I will inspect it." },
              {
                type: "toolCall",
                name: "read",
                arguments: { path: "src/parser.ts", apiKey: "do-not-copy" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "tool-1",
          timestamp: "2026-08-24T00:00:02Z",
          message: {
            role: "toolResult",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "File not found" }],
          },
        },
      ],
    });

    expect(evidence.counts).toMatchObject({
      "message:user": 1,
      "message:assistant": 1,
      "message:toolResult": 1,
      "tool:read": 1,
      "tool-errors": 1,
    });
    expect(evidence.entries[1]?.toolCalls?.[0]).toEqual({
      name: "read",
      arguments: '{"path":"src/parser.ts","apiKey":"[redacted]"}',
    });
    expect(JSON.stringify(evidence)).not.toContain("do-not-copy");
  });

  it("pages normalized evidence without omitting entries", () => {
    const evidence = buildPiSessionEvidence({
      sessionId: "session-1",
      cwd: "/workspace",
      entries: Array.from({ length: 30 }, (_, index) => ({
        type: "message",
        id: `user-${index}`,
        message: { role: "user", content: `Prompt ${index}` },
      })),
    });
    const first = pagePiSessionEvidence(evidence);
    expect(first.entries).toHaveLength(24);
    expect(first.nextCursor).toBe(24);
    const second = pagePiSessionEvidence(evidence, first.nextCursor);
    expect(second.entries).toHaveLength(6);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.entries, ...second.entries].map((entry) => entry.index)).toEqual(
      Array.from({ length: 30 }, (_, index) => index),
    );
  });
});

describe("Pi session review graph", () => {
  it("runs one isolated read-only investigator with only scoped review tools", () => {
    const graph = compilePiSessionReviewGraph({
      runId: "review-pi-session-run",
      cwd: "/workspace",
      model: "provider/model",
      reasoning: "high",
      evidenceTool: "review_pi_session_evidence_run",
      submitTool: "submit_pi_session_review_run",
    });

    expect(graph.concurrency).toBe(1);
    expect(graph.nodes).toHaveLength(1);
    const node = graph.nodes[0];
    const payload = parseDagSubagentPayload(node.executor.payload);
    expect(node.id).toBe("pi-session-investigator");
    expect(payload.workspace).toEqual({ cwd: "/workspace", access: "read" });
    expect(payload.tools).toEqual([
      "review_pi_session_evidence_run",
      "submit_pi_session_review_run",
    ]);
    expect(payload.tools).not.toContain("subagent");
    expect(payload.tools).not.toContain("write");
    expect(payload.context.outputs).toEqual([]);
    expect(payload.maxTurns).toBe(64);
    expect(payload.instructions).toContain("independent reviewer");
    expect(payload.instructions).toContain("Do not edit files");
  });

  it("renders a no-change result without inventing findings", () => {
    expect(
      formatPiSessionReview({
        verdict: "The session does not show material environment friction.",
        evidenceLimitations: ["Successful tool output was normalized."],
        findings: [],
      }),
    ).toContain("### No change");
  });
});
