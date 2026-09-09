import { afterEach, describe, expect, it } from "vitest";

import { resetSlots } from "../../_shared/ui-render";
import { formatActiveJobStatusLines, renderActiveJobStatusSlot } from "../session-runtime";
import { createSubagentHarness } from "./harness";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function job(
  id: string,
  name: string,
  status: string,
  createdAt: string,
  task = "private delegated task",
) {
  return { id, name, status, createdAt, task } as any;
}

afterEach(() => resetSlots());

describe("active subagent status", () => {
  it("renders one brief ordered line per nonterminal background child", () => {
    const lines = formatActiveJobStatusLines(
      [
        job("2", "second", "running", "2026-01-02T00:00:00.000Z"),
        job("1", "first", "queued", "2026-01-01T00:00:00.000Z"),
        job("3", "third", "cancelling", "2026-01-03T00:00:00.000Z"),
        job("4", "finished", "completed", "2026-01-04T00:00:00.000Z"),
        job("5", "failed", "failed", "2026-01-05T00:00:00.000Z"),
      ],
      theme as any,
    );

    expect(lines).toEqual([
      "subagent first [queued]",
      "subagent second [running]",
      "subagent third [cancelling]",
    ]);
    expect(lines.join("\n")).not.toContain("private delegated task");
    expect(lines.join("\n")).not.toContain("•");
  });

  it("places active lines below the editor and clears the slot at terminal state", () => {
    const widgetCalls: Array<{
      key: string;
      content: string[] | undefined;
      options: { placement: string };
    }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        theme,
        setWidget(key: string, content: string[] | undefined, options: { placement: string }) {
          widgetCalls.push({ key, content, options });
        },
        setStatus() {},
      },
    } as any;

    renderActiveJobStatusSlot(
      [
        job("1", "audit", "running", "2026-01-01T00:00:00.000Z"),
        job("2", "tests", "queued", "2026-01-02T00:00:00.000Z"),
      ],
      ctx,
    );
    expect(widgetCalls.filter((call) => call.key === "subagents").at(-1)).toEqual({
      key: "subagents",
      content: ["subagent audit [running]", "subagent tests [queued]"],
      options: { placement: "belowEditor" },
    });

    renderActiveJobStatusSlot(
      [
        job("1", "audit", "completed", "2026-01-01T00:00:00.000Z"),
        job("2", "tests", "cancelled", "2026-01-02T00:00:00.000Z"),
      ],
      ctx,
    );
    expect(widgetCalls.filter((call) => call.key === "subagents").at(-1)).toEqual({
      key: "subagents",
      content: undefined,
      options: { placement: "belowEditor" },
    });
  });

  it("clears active lines when the parent session shuts down", async () => {
    const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        theme,
        setWidget(key: string, content: string[] | undefined) {
          widgetCalls.push({ key, content });
        },
        setStatus() {},
      },
    } as any;
    const harness = createSubagentHarness();

    renderActiveJobStatusSlot(
      [job("1", "audit", "running", "2026-01-01T00:00:00.000Z")],
      ctx,
    );
    await harness.handlers.get("session_shutdown")?.({}, ctx);

    expect(widgetCalls.filter((call) => call.key === "subagents").at(-1)).toEqual({
      key: "subagents",
      content: undefined,
    });
  });
});
