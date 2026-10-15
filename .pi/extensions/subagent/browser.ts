import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, Key, matchesKey, ScrollView, SelectList, Text, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import * as ChildTypes from "./child-types";
import type * as SessionRuntime from "./session-runtime";
import * as Transcript from "./transcript";

type BrowserSource = Pick<SessionRuntime.SubagentSessionRuntime, "listChildren" | "inspectChild" | "cancelChild">;
type Child = NonNullable<ReturnType<BrowserSource["inspectChild"]>>;
type ChildSummary = ReturnType<BrowserSource["listChildren"]>[number];
const VIEWS = ["conversation", "instructions", "configuration", "provenance"] as const;
type View = typeof VIEWS[number];

function oneLine(text: string): string {
  return Transcript.plainChildText(text).replace(/\s+/g, " ").trim();
}

function inputMode(data: string): ChildTypes.NativeInputMode | undefined {
  switch (data) {
    case "p": return ChildTypes.NativeInputMode.Prompt;
    case "s": return ChildTypes.NativeInputMode.Steer;
    case "f": return ChildTypes.NativeInputMode.FollowUp;
    default: return undefined;
  }
}

/** A view onto retained owners. Closing this view never stops a child or switches the parent. */
export class SubagentBrowser implements Component, Focusable {
  private readonly search = new Input({ prompt: "Search: " });
  private list: SelectList;
  private rosterKey = "";
  private selectedId: string | undefined;
  private view: View = "conversation";
  private readonly text = new Text("", 0, 0);
  private readonly scroll = new ScrollView(this.text, { follow: "end", scrollbar: "hidden" });
  private bodyText = "";
  private status = "";
  private disposed = false;
  private hasFocus = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private height = 10;

  constructor(
    private readonly source: BrowserSource,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly compose: (id: string, mode: ChildTypes.NativeInputMode) => Promise<void>,
  ) {
    this.list = this.createList();
    this.timer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, 500);
    this.timer.unref();
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.search.focused = value && !this.selectedId;
  }

  private filteredChildren(): ChildSummary[] {
    const query = this.search.getValue().toLowerCase();
    return this.source.listChildren().filter((child) => oneLine(`${child.name} ${child.id} ${child.state} ${child.model ?? ""}`).toLowerCase().includes(query));
  }

  private createList(): SelectList {
    const list = new SelectList(this.filteredChildren().map((child) => ({
      value: child.id,
      label: oneLine(child.name),
      description: `[${child.state}] ${child.id.slice(0, 8)} ${oneLine(child.model ?? "")}`,
    })), Math.min(8, this.height), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    list.onSelect = (item) => {
      this.selectedId = item.value;
      this.view = "conversation";
      this.search.focused = false;
      this.status = "";
      this.scroll.scrollToEnd();
    };
    list.onCancel = () => this.close();
    return list;
  }

  private updateRoster(): void {
    const children = this.filteredChildren();
    const key = JSON.stringify([this.height, children.map((child) => [child.id, child.name, child.state, child.model])]);
    if (key === this.rosterKey) return;
    const selected = this.list.getSelectedItem()?.value;
    this.rosterKey = key;
    this.list = this.createList();
    const index = children.findIndex((child) => child.id === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
  }

  showStatus(message: string): void {
    if (this.disposed) return;
    this.status = oneLine(message);
    this.tui.requestRender();
  }

  private contents(child: Child): string {
    switch (this.view) {
      case "instructions":
        return `Original coordinator task\n${child.task}\n\nNative system prompt\n${child.systemPrompt}`;
      case "configuration":
        return `Child: ${child.id}\nParent operation: ${child.runId}\nCwd: ${child.cwd}\nModel: ${child.model ?? "unavailable"}\nNative session: ${child.sessionFile ?? "unavailable"}\n\nActive tools\n${child.activeTools.join("\n") || "(none)"}\n\nCallable tools\n${child.callableTools.join("\n") || "(none)"}\n\nInitial result\n${child.initialResult ? child.initialResult.isError ? "Failed" : "Completed" : "Pending"}\n\nOnly continue with pi --session after this owner closes. The session file is not deleted on eviction.`;
      case "provenance":
        return child.inputs.map((input) => `${input.source} · ${input.mode} · ${input.at}\n${input.text}`).join("\n\n") || "No recorded inputs.";
      case "conversation":
        return `Native conversation (compaction may summarize earlier messages)\n\n${Transcript.childMessagesText(child.messages)}`;
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    try {
      if (this.selectedId) this.handleChildInput(data);
      else if ((["tui.select.cancel", "tui.select.confirm", "tui.select.up", "tui.select.down"] as const).some((action) => getKeybindings().matches(data, action))) this.list.handleInput(data);
      else {
        this.search.handleInput(data);
        this.rosterKey = "";
        this.updateRoster();
      }
    } catch (error) {
      this.showStatus(error instanceof Error ? error.message : String(error));
    }
    this.tui.requestRender();
  }

  private handleChildInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.selectedId = undefined;
      this.search.focused = this.hasFocus;
      this.status = "";
      return;
    }
    const id = this.selectedId!;
    if (matchesKey(data, Key.tab)) {
      this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length];
      if (this.view === "conversation") this.scroll.scrollToEnd();
      else this.scroll.scrollTo(0, { disableFollow: true });
      return;
    }
    const mode = inputMode(data);
    if (mode) {
      const child = this.source.inspectChild(id);
      if (!child) throw new Error("Child session is no longer retained.");
      if (mode === ChildTypes.NativeInputMode.Prompt ? child.state !== ChildTypes.NativeChildState.Idle : child.state !== ChildTypes.NativeChildState.Running) {
        throw new Error(mode === ChildTypes.NativeInputMode.Prompt ? "Use prompt only when idle; use steer or follow-up while running." : "Steer and follow-up require a running child; use prompt when idle.");
      }
      void this.compose(id, mode).catch((error) => this.showStatus(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (data === "c") {
      this.showStatus("Cancellation requested; waiting for native settlement.");
      void this.source.cancelChild(id).then(() => this.showStatus(`${id.slice(0, 8)}: cancellation settled.`), (error) => this.showStatus(error instanceof Error ? error.message : String(error)));
      return;
    }
    const actions = [
      [Key.up, () => this.scroll.scrollBy(-1)], [Key.down, () => this.scroll.scrollBy(1)],
      [Key.pageUp, () => this.scroll.scrollBy(-this.height)], [Key.pageDown, () => this.scroll.scrollBy(this.height)],
      [Key.home, () => this.scroll.scrollToStart()], [Key.end, () => this.scroll.scrollToEnd()],
    ] as const;
    actions.find(([key]) => matchesKey(data, key))?.[1]();
  }

  render(width: number): string[] {
    const budget = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    if (budget < 6 || width < 8) return ["Terminal too small.", "Esc back"].slice(0, budget).map((line) => truncateToWidth(line, Math.max(1, width)));
    this.height = Math.max(1, budget - 4);
    try {
      this.updateRoster();
      const child = this.selectedId ? this.source.inspectChild(this.selectedId) : undefined;
      const text = child ? Transcript.plainChildText(this.contents(child)) : "This child is no longer retained. Its native transcript has not been deleted.";
      if (text !== this.bodyText) { this.bodyText = text; this.text.setText(text); }
      const body = this.selectedId ? this.renderChild(width) : [...this.search.render(width), ...this.list.render(width)];
      const title = child ? `${oneLine(child.name)} [${child.state}] · ${this.view}` : `Subagents · ${this.source.listChildren().length} retained sessions`;
      return [this.theme.fg("accent", title), ...(this.status ? [this.theme.fg("warning", this.status)] : []), ...body, this.theme.fg("dim", this.selectedId ? "Esc roster · Tab view · p prompt · s steer · f follow-up · c cancel · ↑↓ scroll" : "Esc parent · Type to search · ↑↓ select · Enter inspect")].slice(0, budget).map((line) => truncateToWidth(line, Math.max(1, width)));
    } catch (error) {
      return ["Subagent view unavailable.", oneLine(error instanceof Error ? error.message : String(error)), "Esc back"].slice(0, budget).map((line) => truncateToWidth(line, Math.max(1, width)));
    }
  }

  private renderChild(width: number): string[] {
    const lines = this.scroll.render(Math.max(1, width));
    this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    return lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
  }

  invalidate(): void { this.search.invalidate(); this.list.invalidate(); this.text.invalidate(); }
  close(): void { if (!this.disposed) { this.dispose(); this.done(); } }
  dispose(): void { if (!this.disposed) { this.disposed = true; clearInterval(this.timer); } }
}
