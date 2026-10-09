import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Input,
  Key,
  matchesKey,
  ScrollView,
  SelectList,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

import type { SubagentJob } from "./jobs";
import { DISPLAY_CHARACTERS, plainChildText, readChildTranscript } from "./transcript";

const DIAGNOSTIC_CHARACTERS = 1_024;

function childMetadataLine(text: string): string {
  return plainChildText(text).replace(/\s+/g, " ").trim();
}

export class SubagentBrowser implements Component, Focusable {
  private readonly search = new Input({ prompt: "Search: " });
  private list: SelectList;
  private rosterKey = "";
  private selectedId: string | undefined;
  private readonly text = new Text("Loading finalized child messages…", 0, 0);
  private readonly scroll = new ScrollView(this.text, { follow: "end", scrollbar: "hidden" });
  private transcriptPath: string | undefined;
  private reading = false;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private height = 10;

  constructor(
    private readonly jobs: () => readonly SubagentJob[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    this.list = this.createList();
    this.updateRoster();
    this.timer = setInterval(() => {
      this.updateRoster();
      void this.refreshTranscript();
      this.tui.requestRender();
    }, 1_000);
    this.timer.unref();
  }

  get focused(): boolean {
    return this.search.focused;
  }
  set focused(value: boolean) {
    this.search.focused = value && !this.selectedId;
  }

  private filteredJobs(): readonly SubagentJob[] {
    const query = this.search.getValue().toLowerCase();
    return this.jobs().filter((job) =>
      plainChildText(`${job.name} ${job.id} ${job.status} ${job.latestDetails?.model ?? ""}`)
        .toLowerCase()
        .includes(query),
    );
  }

  private createList(): SelectList {
    const list = new SelectList(
      this.filteredJobs().map((job) => ({
        value: job.id,
        label: childMetadataLine(job.name),
        description: `[${job.status}] ${childMetadataLine(job.id.slice(0, 8))} ${childMetadataLine(job.latestDetails?.model ?? "")}`,
      })),
      Math.min(8, this.height),
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    );
    list.onSelect = (item) => {
      this.selectedId = item.value;
      this.search.focused = false;
      this.transcriptPath = undefined;
      this.text.setText("Loading finalized child messages…");
      this.scroll.scrollToEnd();
      void this.refreshTranscript();
    };
    list.onCancel = () => this.close();
    return list;
  }

  private updateRoster(): void {
    const key = JSON.stringify([
      this.height,
      this.jobs().map((job) => [job.id, job.name, job.status, job.latestDetails?.model]),
    ]);
    if (key === this.rosterKey) return;
    const selected = this.list.getSelectedItem()?.value;
    this.rosterKey = key;
    this.list = this.createList();
    // Preserve selection by identity when jobs finish, disappear, or enter the roster.
    const index = this.filteredJobs().findIndex((job) => job.id === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
  }

  private async refreshTranscript(): Promise<void> {
    if (this.disposed || this.reading || !this.selectedId) return;
    const id = this.selectedId;
    const job = this.jobs().find((candidate) => candidate.id === id);
    if (!job) {
      this.transcriptPath = undefined;
      this.text.setText(
        "This job is no longer retained. Its child transcript has not been deleted.",
      );
      return;
    }
    const path = job.latestDetails?.sessionFile;
    if (!path) {
      this.setTranscriptText(
        job,
        plainChildText(
          (job.resultText ?? "Child transcript is not available yet.").slice(0, DISPLAY_CHARACTERS),
        ),
      );
      return;
    }
    this.reading = true;
    try {
      const transcript = await readChildTranscript(path);
      if (this.disposed || this.selectedId !== id) return;
      const current = this.jobs().find((candidate) => candidate.id === id);
      if (current?.latestDetails?.sessionFile !== path) {
        this.transcriptPath = undefined;
        this.text.setText(
          current
            ? "Child transcript changed. Refreshing…"
            : "This job is no longer retained. Its child transcript has not been deleted.",
        );
        this.tui.requestRender();
        return;
      }
      this.transcriptPath = path;
      this.setTranscriptText(current, transcript.text);
      this.tui.requestRender();
    } finally {
      this.reading = false;
    }
  }

  private setTranscriptText(job: SubagentJob, text: string): void {
    const error = job.errorMessage || job.latestDetails?.errorMessage;
    const diagnostic = error
      ? `Error: ${childMetadataLine(error.slice(0, DIAGNOSTIC_CHARACTERS))}${error.length > DIAGNOSTIC_CHARACTERS ? " [Diagnostic truncated.]" : ""}`
      : job.latestDetails?.stopReason === "aborted"
        ? "Child run aborted."
        : "";
    this.text.setText([diagnostic, text].filter(Boolean).join("\n\n"));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.selectedId) {
      this.handleTranscriptInput(data);
    } else if (
      (
        ["tui.select.cancel", "tui.select.confirm", "tui.select.up", "tui.select.down"] as const
      ).some((action) => getKeybindings().matches(data, action))
    ) {
      this.list.handleInput(data);
    } else {
      this.search.handleInput(data);
      this.rosterKey = "";
      this.updateRoster();
    }
    this.tui.requestRender();
  }

  private handleTranscriptInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.selectedId = undefined;
      this.search.focused = true;
      return;
    }
    const actions = [
      [Key.up, () => this.scroll.scrollBy(-1)],
      [Key.down, () => this.scroll.scrollBy(1)],
      [Key.pageUp, () => this.scroll.scrollBy(-this.height)],
      [Key.pageDown, () => this.scroll.scrollBy(this.height)],
      [Key.home, () => this.scroll.scrollToStart()],
      [Key.end, () => this.scroll.scrollToEnd()],
    ] as const;
    actions.find(([key]) => matchesKey(data, key))?.[1]();
  }

  render(width: number): string[] {
    const budget = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    if (budget < 6 || width < 8) {
      return ["Terminal too small for subagents.", this.selectedId ? "Esc jobs" : "Esc parent"]
        .slice(0, budget)
        .map((line) => truncateToWidth(line, Math.max(1, width)));
    }
    this.height = Math.max(1, Math.min(16, budget - 4));
    this.updateRoster();
    const job = this.jobs().find((candidate) => candidate.id === this.selectedId);
    const body = this.selectedId
      ? this.renderTranscript(width)
      : [...this.search.render(width), ...this.list.render(width)];
    const title = this.selectedId
      ? `${childMetadataLine(job?.name ?? "Unretained job")} [${job?.status ?? "unknown"}] · read-only`
      : `Subagents · ${this.jobs().length} retained background jobs`;
    const context = this.selectedId
      ? [
          childMetadataLine(`Job: ${this.selectedId} · ${job?.task ?? ""}`),
          childMetadataLine(this.transcriptPath ?? ""),
        ]
      : [];
    return [
      this.theme.fg("accent", title),
      ...context,
      ...body,
      this.theme.fg(
        "dim",
        this.selectedId
          ? "↑↓/PgUp/PgDn scroll · End follow · Esc jobs"
          : "Type to search · ↑↓ select · Enter inspect · Esc parent",
      ),
    ].map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  private renderTranscript(width: number): string[] {
    const lines = this.scroll.render(Math.max(1, width));
    this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    return lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
    this.text.invalidate();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }
}
