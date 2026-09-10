import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentNotificationExtension from "../index";
import * as AgentTools from "../../_shared/agent-tools";

type SettledHandler = (
  event: { type: typeof AgentTools.PiEvent.AgentSettled },
  context: ExtensionContext,
) => unknown;

function settledHandler(): SettledHandler {
  let handler: SettledHandler | undefined;
  const pi = {
    on(event: string, candidate: SettledHandler) {
      if (event === AgentTools.PiEvent.AgentSettled) handler = candidate;
    },
  } as unknown as ExtensionAPI;

  agentNotificationExtension(pi);
  expect(handler).toBeTypeOf("function");
  return handler!;
}

function context(mode: ExtensionContext["mode"], hasUI: boolean): ExtensionContext {
  return { mode, hasUI } as ExtensionContext;
}

function emittedBytes(write: ReturnType<typeof vi.spyOn>): number[] {
  return write.mock.calls.flatMap(([chunk]: unknown[]) => [...Buffer.from(String(chunk))]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent notification extension", () => {
  it("emits one terminal bell for each settled TUI run", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = settledHandler();

    expect(emittedBytes(write)).toEqual([]);
    handler({ type: AgentTools.PiEvent.AgentSettled }, context("tui", true));
    expect(emittedBytes(write)).toEqual([0x07]);
    handler({ type: AgentTools.PiEvent.AgentSettled }, context("tui", true));
    expect(emittedBytes(write)).toEqual([0x07, 0x07]);
  });

  it.each([
    ["rpc", true],
    ["json", false],
    ["print", false],
  ] as const)("does not emit a terminal bell in %s mode", (mode, hasUI) => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = settledHandler();

    handler({ type: AgentTools.PiEvent.AgentSettled }, context(mode, hasUI));

    expect(emittedBytes(write)).toEqual([]);
  });

  it.each([undefined, "", "/arbitrary/nonexistent/socket"])(
    "does not require a tmux environment (%s)",
    (tmux) => {
      vi.stubEnv("TMUX", tmux);
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const handler = settledHandler();

      handler({ type: AgentTools.PiEvent.AgentSettled }, context("tui", true));

      expect(emittedBytes(write)).toEqual([0x07]);
    },
  );
});
