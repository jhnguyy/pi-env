import type { SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SessionResumePicker } from "../picker";

const keybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.tree.foldOrUp": { defaultKeys: "ctrl+left", description: "Fold or select parent" },
  "app.tree.unfoldOrDown": { defaultKeys: "ctrl+right", description: "Unfold or select child" },
});
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function session(id: string, parentSessionPath?: string): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    parentSessionPath,
    cwd: "/project",
    name: id,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  };
}

describe("session resume picker", () => {
  it("expands, selects a child, and returns to its parent", () => {
    const parent = session("parent");
    const child = session("child", parent.path);
    let selectedPath: string | undefined;
    const picker = new SessionResumePicker(
      { current: [parent, child], all: [parent, child] },
      theme,
      keybindings,
      (path) => {
        selectedPath = path;
      },
    );

    expect(picker.render(100).join("\n")).toContain("▶ parent");
    expect(picker.render(100).join("\n")).not.toContain("child");

    picker.handleInput("\x1b[1;5C");
    expect(picker.render(100).join("\n")).toContain("└─ child");
    picker.handleInput("\x1b[1;5C");
    picker.handleInput("\x1b[1;5D");
    picker.handleInput("\r");

    expect(selectedPath).toBe(parent.path);
  });

  it("shows matching children while the tree is collapsed", () => {
    const parent = session("parent");
    const child = session("unique-child", parent.path);
    const picker = new SessionResumePicker(
      { current: [parent, child], all: [parent, child] },
      theme,
      keybindings,
      () => {},
    );

    for (const character of "unique") picker.handleInput(character);

    expect(picker.render(100).join("\n")).toContain("unique-child");
  });

  it("toggles between current-folder and all sessions", () => {
    const current = session("current");
    const other = session("other");
    const picker = new SessionResumePicker(
      { current: [current], all: [current, other] },
      theme,
      keybindings,
      () => {},
    );

    expect(picker.render(100).join("\n")).not.toContain("other");
    picker.handleInput("\t");
    expect(picker.render(100).join("\n")).toContain("other");
  });
});
