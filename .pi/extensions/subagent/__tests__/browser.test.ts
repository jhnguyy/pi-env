import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentBrowser } from "../browser";
import type { NativeChildSnapshot } from "../native-child";

// Isolated presentation check: native widgets need deterministic viewport and key input.
// Registered-command/native-session interaction is covered by registered-native.integration.
it("inspects authoritative multiline data and routes explicit actions without owning the child", async () => {
  const child: NativeChildSnapshot = {
    id: "child-id", runId: "operation-id", name: "界 child", task: "\u001b]52;c;evil\u0007First line\nSecond line\u0000",
    cwd: "/target", sessionFile: "/sessions/child.jsonl", model: "child/model", systemPrompt: "Native system\nDelegated instruction" + "\nContext line".repeat(80),
    activeTools: ["read"], callableTools: ["read", "late"], messages: [],
    inputs: [{ source: "human", mode: "prompt", text: "Human original\nsecond line", at: "now" }], state: "idle",
  };
  const done = vi.fn();
  const cancelChild = vi.fn(async () => {});
  const compose = vi.fn(async () => {});
  const tui = { terminal: { rows: 60 }, requestRender: vi.fn() };
  const theme = { fg: (_color: string, text: string) => text };
  const source = { listChildren: () => [child], inspectChild: () => child, cancelChild };
  const browser = new SubagentBrowser(source, tui as any, theme as any, done, compose);
  try {
    browser.focused = true;
    browser.render(160);
    browser.handleInput("\r");
    browser.handleInput("\t");
    const instructions = browser.render(160).map((line) => line.trimEnd()).join("\n");
    expect(instructions).toContain("First line\nSecond line");
    expect(instructions).toContain("Native system\nDelegated instruction");
    expect(instructions).not.toContain("\u001b");
    expect(instructions).not.toContain("evil");
    browser.handleInput("\t");
    const configuration = browser.render(160).map((line) => line.trimEnd()).join("\n");
    expect(configuration).toContain("Cwd: /target");
    expect(configuration).toContain("Active tools\nread\n\nCallable tools\nread\nlate");
    browser.handleInput("\t");
    expect(browser.render(160).map((line) => line.trimEnd()).join("\n")).toContain("Human original\nsecond line");
    browser.handleInput("s");
    expect(compose).not.toHaveBeenCalled();
    browser.handleInput("p");
    expect(compose).toHaveBeenLastCalledWith("child-id", "prompt");
    child.state = "running";
    browser.handleInput("s");
    expect(compose).toHaveBeenLastCalledWith("child-id", "steer");
    browser.handleInput("f");
    expect(compose).toHaveBeenLastCalledWith("child-id", "followUp");
    browser.handleInput("c");
    await Promise.resolve();
    expect(cancelChild).toHaveBeenCalledWith("child-id");
    expect(done).not.toHaveBeenCalled();
    browser.handleInput("\u001b");
    browser.handleInput("\u001b");
    expect(done).toHaveBeenCalledTimes(1);
    expect(cancelChild).toHaveBeenCalledTimes(1);
  } finally { browser.dispose(); }
});

it("bounds native rendering on resize and treats view disposal as UI-only", () => {
  const tui = { terminal: { rows: 20 }, requestRender: vi.fn() };
  const source = { listChildren: () => [], inspectChild: () => undefined, cancelChild: vi.fn(async () => {}) };
  const done = vi.fn();
  const browser = new SubagentBrowser(source, tui as any, { fg: (_color: string, text: string) => text } as any, done, async () => {});
  try {
    for (const [width, rows] of [[40, 20], [8, 8], [2, 3]]) {
      tui.terminal.rows = rows;
      browser.invalidate();
      const rendered = browser.render(width);
      expect(rendered.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    browser.dispose();
    browser.dispose();
    expect(source.cancelChild).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  } finally { browser.dispose(); }
});
