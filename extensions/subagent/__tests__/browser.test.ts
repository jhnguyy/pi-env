import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Browser from "../browser";
import * as ChildTypes from "../child-types";

it("requests renders on child changes, not idle time, and unsubscribes on disposal", () => {
  const poll = vi.spyOn(globalThis, "setInterval");
  const listeners = new Set<() => void>();
  const requestRender = vi.fn();
  const source = {
    listChildren: () => [],
    inspectChild: () => undefined,
    inspectChildTools: () => undefined,
    cancelChild: async () => {},
    subscribeChildren: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const browser = new Browser.SubagentBrowser(
    source,
    { terminal: { rows: 20 }, requestRender } as any,
    { fg: (_color: string, text: string) => text } as any,
    () => {},
    async () => {},
  );
  try {
    expect(listeners.size).toBe(1);
    expect(poll).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    for (const listener of listeners) listener();
    expect(requestRender).toHaveBeenCalledOnce();
    browser.dispose();
    browser.dispose();
    expect(listeners.size).toBe(0);
    for (const listener of listeners) listener();
    expect(requestRender).toHaveBeenCalledOnce();
  } finally {
    browser.dispose();
    poll.mockRestore();
  }
});

it("checks only tool names while Configuration is open and renders only changes", () => {
  const poll = vi.spyOn(globalThis, "setInterval");
  const stop = vi.spyOn(globalThis, "clearInterval");
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
      subscribeChildren: () => () => {},
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
    expect(poll).not.toHaveBeenCalled();
    browser.handleInput("\t");
    browser.render(160);
    expect(poll).toHaveBeenCalledOnce();
    const tick = poll.mock.calls[0][0];
    requestRender.mockClear();
    inspectChild.mockClear();
    tick();
    expect(inspectChildTools).toHaveBeenCalled();
    expect(inspectChild).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    child.activeTools = ["read", "late"];
    child.callableTools = ["read", "late"];
    tick();
    expect(requestRender).toHaveBeenCalledOnce();
    tick();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(browser.render(160).join("\n")).toContain("late");
    browser.setVisible(false);
    expect(stop).toHaveBeenCalledWith(poll.mock.results[0].value);
    const hiddenReads = inspectChildTools.mock.calls.length;
    tick();
    expect(inspectChildTools).toHaveBeenCalledTimes(hiddenReads);
    requestRender.mockClear();
    browser.setVisible(true);
    expect(requestRender).toHaveBeenCalledOnce();
    browser.handleInput("\t");
    expect(stop).toHaveBeenCalledWith(poll.mock.results.at(-1)!.value);
    const reads = inspectChildTools.mock.calls.length;
    tick();
    expect(inspectChildTools).toHaveBeenCalledTimes(reads);
    browser.handleInput("\t");
    browser.handleInput("\t");
    browser.handleInput("\t");
    const finalTick = poll.mock.calls.at(-1)![0];
    const finalReads = inspectChildTools.mock.calls.length;
    browser.dispose();
    expect(stop).toHaveBeenCalledWith(poll.mock.results.at(-1)!.value);
    finalTick();
    expect(inspectChildTools).toHaveBeenCalledTimes(finalReads);
  } finally {
    browser.dispose();
    poll.mockRestore();
    stop.mockRestore();
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
        source: ChildTypes.NativeInputSource.Human,
        mode: ChildTypes.NativeInputMode.Prompt,
        text: "Human original\nsecond line",
        at: "now",
      },
    ],
    state: ChildTypes.NativeChildState.Idle,
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
    expect(browser.render(160).join("\n")).toContain("require a running child");
    for (const [state, key, mode] of [
      [ChildTypes.NativeChildState.Idle, "p", ChildTypes.NativeInputMode.Prompt],
      [ChildTypes.NativeChildState.Running, "s", ChildTypes.NativeInputMode.Steer],
      [ChildTypes.NativeChildState.Running, "f", ChildTypes.NativeInputMode.FollowUp],
    ] as const) {
      child.state = state;
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
