import "../../__tests__/tui-setup";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ptcExtension from "../index";
import {
  PTC_DETAILS_SCHEMA_VERSION,
  PtcCompletion,
  type PtcRunDetails,
} from "../execution-details";
import { PtcAction } from "../types";

const theme = {
  fg: (_style: string, text: string) => text,
  bold: (text: string) => text,
};


function registeredPtcTool() {
  const registerTool = vi.fn();
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const lifecycleHandlers = new Map<string, Array<() => void>>();
  // The public extension entrypoint requires the external host's full ExtensionAPI; this rendering harness implements only the exercised surface.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const pi = {
    registerTool,
    getActiveTools: () => [],
    getAllTools: () => [],
    events: {
      emit(event: string, value: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      on(event: string, listener: (value: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => undefined;
      },
    },
    on(event: string, handler: () => void) {
      lifecycleHandlers.set(event, [...(lifecycleHandlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  ptcExtension(pi);
  onTestFinished(() => {
    for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) handler();
  });
  return registerTool.mock.calls[0][0];
}

function details(overrides: Partial<PtcRunDetails> = {}): PtcRunDetails {
  return {
    schemaVersion: PTC_DETAILS_SCHEMA_VERSION,
    action: PtcAction.Run,
    completion: PtcCompletion.Success,
    durationMs: 12,
    nestedCallCount: 0,
    completedNestedCallCount: 0,
    failedNestedCallCount: 0,
    toolCallCounts: [],
    outputTruncated: false,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {},
    args: { action: PtcAction.Run, code: 'return "done";' },
    isError: false,
    ...overrides,
  } as never;
}

function componentText(component: unknown): string {
  return (component as { text: string }).text;
}

describe("PTC result rendering", () => {
  it("renders final call counts and truncation from durable details", () => {
    const tool = registeredPtcTool();
    const result = {
      content: [{ type: "text", text: "first\nsecond\nthird" }],
      details: details({
        nestedCallCount: 3,
        completedNestedCallCount: 3,
        toolCallCounts: [{ tool: "read", count: 3 }],
        outputTruncated: true,
      }),
    };

    const collapsed = componentText(
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, context()),
    );
    const expanded = componentText(
      tool.renderResult(result, { expanded: true, isPartial: false }, theme, context()),
    );

    expect(collapsed).toContain("3 lines · 3 calls · [truncated]");
    expect(expanded).toContain("3 lines · 3 calls · [truncated]");
    expect(expanded).toContain('return "done";');
    expect(expanded).toContain("first\nsecond\nthird");
  });

  it("keeps live nested-call labels in transient state while execution is partial", () => {
    const tool = registeredPtcTool();
    const renderContext = context({ state: {} });

    const first = componentText(
      tool.renderResult(
        { content: [{ type: "text", text: '→ read(path="one") #1' }], details: undefined },
        { expanded: false, isPartial: true },
        theme,
        renderContext,
      ),
    );
    const second = componentText(
      tool.renderResult(
        { content: [{ type: "text", text: '→ read(path="two") #2' }], details: undefined },
        { expanded: false, isPartial: true },
        theme,
        renderContext,
      ),
    );

    expect(first).toBe('→ read(path="one") #1');
    expect(second).toContain('→ read(path="one") #1\n→ read(path="two") #2');
  });

  it("renders nested and timeout failures from durable error text", () => {
    const tool = registeredPtcTool();
    const nested = "PTC run failed: PTC nested tool call failed\nTool: read\nError: denied";
    const timeout = "PTC run failed: PTC timed out after 120s\nCompleted nested tool calls: 2";

    const collapsed = componentText(
      tool.renderResult(
        { content: [{ type: "text", text: nested }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context({ isError: true }),
      ),
    );
    const expanded = componentText(
      tool.renderResult(
        { content: [{ type: "text", text: timeout }], details: undefined },
        { expanded: true, isPartial: false },
        theme,
        context({ isError: true }),
      ),
    );

    expect(collapsed).toContain("✗ ptc PTC run failed: PTC nested tool call failed");
    expect(expanded).toContain("PTC timed out after 120s");
    expect(expanded).toContain("Completed nested tool calls: 2");
  });
});
