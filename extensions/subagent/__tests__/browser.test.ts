import { mock } from "node:test";
import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Browser from "../browser";
import * as ChildTypes from "../child-types";

it("refreshes changed configuration without idle transcript work and releases background work", () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const listeners = new Set<() => void>();
  const child = {
    id: "idle-child",
    runId: "run",
    name: "idle",
    task: "task",
    cwd: "/target",
    sessionFile: undefined,
    model: undefined,
    systemPrompt: "",
    activeTools: ["read"],
    callableTools: ["read"],
    messages: [],
    inputs: [],
    state: ChildTypes.NativeChildState.Idle,
    availableInputs: [ChildTypes.NativeInputMode.Prompt],
  };
  const inspectChild = vi.fn(() => child);
  const inspectChildTools = vi.fn(() => ({
    activeTools: child.activeTools,
    callableTools: child.callableTools,
  }));
  const requestRender = vi.fn();
  const browser = new Browser.SubagentBrowser(
    {
      listChildren: () => [child],
      inspectChild,
      inspectChildTools,
      cancelChild: async () => {},
      subscribeChildren: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    { terminal: { rows: 60 }, requestRender } as any,
    { fg: (_color: string, text: string) => text } as any,
    () => {},
    async () => {},
  );
  try {
    browser.render(160);
    browser.handleInput("\r");
    browser.handleInput("\t");
    requestRender.mockClear();
    inspectChild.mockClear();
    mock.timers.tick(1000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(inspectChild).not.toHaveBeenCalled();
    browser.handleInput("\t");
    browser.render(160);
    requestRender.mockClear();
    inspectChild.mockClear();
    mock.timers.tick(1000);
    expect(inspectChildTools).toHaveBeenCalled();
    expect(inspectChild).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    child.activeTools = ["read", "late"];
    child.callableTools = ["read", "late"];
    mock.timers.tick(1000);
    expect(requestRender).toHaveBeenCalled();
    requestRender.mockClear();
    mock.timers.tick(1000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(browser.render(160).join("\n")).toContain("late");
    browser.setVisible(false);
    const hiddenReads = inspectChildTools.mock.calls.length;
    mock.timers.tick(1000);
    expect(inspectChildTools).toHaveBeenCalledTimes(hiddenReads);
    requestRender.mockClear();
    browser.setVisible(true);
    expect(requestRender).toHaveBeenCalled();
    browser.handleInput("\t");
    const reads = inspectChildTools.mock.calls.length;
    mock.timers.tick(1000);
    expect(inspectChildTools).toHaveBeenCalledTimes(reads);
    browser.handleInput("\t");
    browser.handleInput("\t");
    browser.handleInput("\t");
    const finalReads = inspectChildTools.mock.calls.length;
    browser.dispose();
    requestRender.mockClear();
    mock.timers.tick(1000);
    expect(inspectChildTools).toHaveBeenCalledTimes(finalReads);
    expect(requestRender).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  } finally {
    browser.dispose();
    mock.timers.reset();
  }
});

// Deterministic viewport and arbitrary-key presentation gap. The registered
// native workflow and terminal smoke cover real owner actions and editor transport.
it("renders supplied snapshot fields and handles supported editor shortcut keys", async () => {
  const child: ChildTypes.NativeChildSnapshot = {
    id: "child-id",
    runId: "operation-id",
    name: "界 child",
    task: "\u001b]52;c;evil\u0007First line\nSecond line\u0000",
    cwd: "/target",
    sessionFile: "/sessions/child.jsonl",
    model: "child/model",
    systemPrompt: "Native system\nDelegated instruction" + "\nContext line".repeat(80),
    activeTools: ["read"],
    callableTools: ["read", "late"],
    messages: [],
    inputs: [
      {
        source: ChildTypes.InputProvenance.Human,
        mode: ChildTypes.NativeInputMode.Prompt,
        text: "Human original\nsecond line",
        at: "now",
      },
    ],
    state: ChildTypes.NativeChildState.Running,
    availableInputs: [],
  };
  let viewOpen = true;
  let editorTitle = "";
  const tui = { terminal: { rows: 60 }, requestRender: () => {} };
  const theme = { fg: (_color: string, text: string) => text };
  const source = {
    listChildren: () => [child],
    inspectChild: () => child,
    inspectChildTools: () => ({
      activeTools: child.activeTools,
      callableTools: child.callableTools,
    }),
    cancelChild: async () => {},
    subscribeChildren: () => () => {},
  };
  const browser = new Browser.SubagentBrowser(
    source,
    tui as any,
    theme as any,
    () => {
      viewOpen = false;
    },
    async (id, mode) => {
      editorTitle = `${mode} · ${id}`;
    },
  );
  try {
    browser.focused = true;
    browser.render(160);
    browser.handleInput("\r");
    browser.handleInput("\t");
    const instructions = browser
      .render(160)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(instructions).toContain("First line\nSecond line");
    expect(instructions).toContain("Native system\nDelegated instruction");
    expect(instructions).not.toContain("\u001b");
    expect(instructions).not.toContain("evil");
    browser.handleInput("\t");
    const configuration = browser
      .render(160)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(configuration).toContain("Cwd: /target");
    expect(configuration).toContain("Active tools\nread\n\nCallable tools\nread\nlate");
    browser.handleInput("\t");
    expect(
      browser
        .render(160)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toContain("Human original\nsecond line");
    browser.handleInput("s");
    expect(editorTitle).toBe("");
    for (const [state, key, mode] of [
      [ChildTypes.NativeChildState.Idle, "p", ChildTypes.NativeInputMode.Prompt],
      [ChildTypes.NativeChildState.Running, "s", ChildTypes.NativeInputMode.Steer],
      [ChildTypes.NativeChildState.Running, "f", ChildTypes.NativeInputMode.FollowUp],
    ] as const) {
      child.state = state;
      child.availableInputs = [mode];
      browser.showStatus("Ready");
      browser.handleInput(key);
      await Promise.resolve();
      expect(editorTitle).toBe(`${mode} · child-id`);
      const rendered = browser.render(160);
      for (const unknown of ["x", "constructor", "toString", "__proto__"])
        browser.handleInput(unknown);
      expect(editorTitle).toBe(`${mode} · child-id`);
      expect(browser.render(160)).toEqual(rendered);
    }
    expect(viewOpen).toBe(true);
    browser.handleInput("\u001b");
    browser.handleInput("\u001b");
    expect(viewOpen).toBe(false);
  } finally {
    browser.dispose();
  }
});

it("bounds rendered dimensions on resize and ignores keys after view disposal", () => {
  const tui = { terminal: { rows: 20 }, requestRender: () => {} };
  const source = {
    listChildren: () => [],
    inspectChild: () => undefined,
    inspectChildTools: () => undefined,
    cancelChild: async () => {},
    subscribeChildren: () => () => {},
  };
  let viewOpen = true;
  const browser = new Browser.SubagentBrowser(
    source,
    tui as any,
    { fg: (_color: string, text: string) => text } as any,
    () => {
      viewOpen = false;
    },
    async () => {},
  );
  try {
    for (const [width, rows] of [
      [40, 20],
      [8, 8],
      [2, 3],
    ]) {
      tui.terminal.rows = rows;
      browser.invalidate();
      const rendered = browser.render(width);
      expect(rendered.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    browser.dispose();
    browser.dispose();
    browser.handleInput("\u001b");
    expect(viewOpen).toBe(true);
  } finally {
    browser.dispose();
  }
});
