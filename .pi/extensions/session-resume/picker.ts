import type { SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import {
  buildSessionTree,
  flattenVisibleSessions,
  searchSessions,
  type VisibleSession,
} from "./tree";

interface PickerSessions {
  readonly current: readonly SessionInfo[];
  readonly all: readonly SessionInfo[];
}

type PickerScope = keyof PickerSessions;

function sessionLabel(session: SessionInfo): string {
  return (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function treePrefix(node: VisibleSession): string {
  const disclosure = node.hasChildren ? (node.isExpanded ? "▼ " : "▶ ") : "";
  if (node.depth === 0) return disclosure;
  const ancestors = node.ancestorContinues.map((continues) => (continues ? "│  " : "   ")).join("");
  return `${ancestors}${node.isLast ? "└─ " : "├─ "}${disclosure}`;
}

function keyLabel(
  keybindings: KeybindingsManager,
  action: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(action).join("/");
}

export class SessionResumePicker implements Component, Focusable {
  readonly #sessions: PickerSessions;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: (path: string | undefined) => void;
  readonly #search = new Input();
  readonly #expandedPaths = new Set<string>();
  #scope: PickerScope = "current";
  #visible: VisibleSession[] = [];
  #selectedIndex = 0;
  #focused = false;

  constructor(
    sessions: PickerSessions,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (path: string | undefined) => void,
  ) {
    this.#sessions = sessions;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#done = done;
    this.#rebuild();
    this.#search.onSubmit = () => this.#select();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#search.focused = value;
  }

  #activeSessions(): readonly SessionInfo[] {
    return this.#sessions[this.#scope];
  }

  #rebuild(): void {
    const selectedPath = this.#visible[this.#selectedIndex]?.path;
    const query = this.#search.getValue();
    this.#visible = query.trim()
      ? searchSessions(this.#activeSessions(), query)
      : flattenVisibleSessions(buildSessionTree(this.#activeSessions()), this.#expandedPaths);
    const preservedIndex = selectedPath
      ? this.#visible.findIndex((node) => node.path === selectedPath)
      : -1;
    this.#selectedIndex =
      preservedIndex >= 0
        ? preservedIndex
        : Math.min(this.#selectedIndex, Math.max(0, this.#visible.length - 1));
  }

  #select(): void {
    const selected = this.#visible[this.#selectedIndex];
    if (selected) this.#done(selected.session.path);
  }

  #foldOrSelectParent(): void {
    const selected = this.#visible[this.#selectedIndex];
    if (!selected) return;
    if (selected.isExpanded) {
      this.#expandedPaths.delete(selected.path);
      this.#rebuild();
      return;
    }
    if (!selected.parentPath) return;
    const parentIndex = this.#visible.findIndex((node) => node.path === selected.parentPath);
    if (parentIndex >= 0) this.#selectedIndex = parentIndex;
  }

  #unfoldOrSelectChild(): void {
    const selected = this.#visible[this.#selectedIndex];
    if (!selected?.hasChildren) return;
    if (!selected.isExpanded) {
      this.#expandedPaths.add(selected.path);
      this.#rebuild();
      return;
    }
    this.#selectedIndex = Math.min(this.#selectedIndex + 1, this.#visible.length - 1);
  }

  handleInput(data: string): void {
    if (this.#keybindings.matches(data, "tui.select.cancel")) {
      this.#done(undefined);
      return;
    }
    if (this.#keybindings.matches(data, "tui.input.tab")) {
      this.#scope = this.#scope === "current" ? "all" : "current";
      this.#selectedIndex = 0;
      this.#rebuild();
      return;
    }
    if (!this.#search.getValue().trim() && this.#keybindings.matches(data, "app.tree.foldOrUp")) {
      this.#foldOrSelectParent();
      return;
    }
    if (
      !this.#search.getValue().trim() &&
      this.#keybindings.matches(data, "app.tree.unfoldOrDown")
    ) {
      this.#unfoldOrSelectChild();
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.up")) {
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.down")) {
      this.#selectedIndex = Math.max(
        0,
        Math.min(this.#visible.length - 1, this.#selectedIndex + 1),
      );
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.pageUp")) {
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 10);
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.pageDown")) {
      this.#selectedIndex = Math.max(
        0,
        Math.min(this.#visible.length - 1, this.#selectedIndex + 10),
      );
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.confirm")) {
      this.#select();
      return;
    }
    this.#search.handleInput(data);
    this.#rebuild();
  }

  render(width: number): string[] {
    const title =
      this.#scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
    const foldKey = keyLabel(this.#keybindings, "app.tree.foldOrUp");
    const unfoldKey = keyLabel(this.#keybindings, "app.tree.unfoldOrDown");
    const lines = [
      truncateToWidth(this.#theme.bold(title), width),
      truncateToWidth(
        this.#theme.fg("muted", `tab scope · ${foldKey} fold · ${unfoldKey} unfold`),
        width,
      ),
      ...this.#search.render(width),
      "",
    ];
    if (this.#visible.length === 0) {
      lines.push(this.#theme.fg("muted", "  No sessions found"));
      return lines;
    }

    const maxVisible = 12;
    const start = Math.max(
      0,
      Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#visible.length - maxVisible),
    );
    const end = Math.min(start + maxVisible, this.#visible.length);
    for (let index = start; index < end; index += 1) {
      const node = this.#visible[index];
      const selected = index === this.#selectedIndex;
      const cursor = selected ? this.#theme.fg("accent", "› ") : "  ";
      const prefix = this.#theme.fg("dim", treePrefix(node));
      const cwd = this.#scope === "all" && node.session.cwd ? `  ${node.session.cwd}` : "";
      const available = Math.max(
        10,
        width - visibleWidth(cursor) - visibleWidth(prefix) - visibleWidth(cwd),
      );
      const label = truncateToWidth(sessionLabel(node.session), available, "…");
      let line = truncateToWidth(
        `${cursor}${prefix}${selected ? this.#theme.bold(label) : label}${this.#theme.fg("dim", cwd)}`,
        width,
      );
      if (selected) line = this.#theme.bg("selectedBg", line);
      lines.push(line);
    }
    if (start > 0 || end < this.#visible.length) {
      lines.push(this.#theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#visible.length})`));
    }
    return lines;
  }

  invalidate(): void {
    this.#search.invalidate();
  }
}
