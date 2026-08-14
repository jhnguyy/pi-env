import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Finding, PlanFile, ReviewState } from "./core";

type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type WalkthroughNotice = DeepReadonly<{
  kind: "info" | "warning" | "error" | "success";
  message: string;
}>;

export type WalkthroughActionResult = DeepReadonly<{
  action: "select" | "edit" | "preface" | "rerun" | "post" | "inspect" | "cleanup" | "help";
  ok: boolean;
  notice: WalkthroughNotice;
}>;

export type WalkthroughIntent =
  | { kind: "cancel" }
  | { kind: "toggleSelection"; findingId: string }
  | { kind: "edit"; findingId?: string }
  | { kind: "editPreface" }
  | { kind: "rerun" }
  | { kind: "post" }
  | { kind: "inspectChild" }
  | { kind: "cleanup" }
  | { kind: "help" };

export type WalkthroughPageKind = "overview" | "file" | "finding" | "unanchored" | "finalize";

export type WalkthroughViewModel = DeepReadonly<{
  reviewId: string;
  title: string;
  url: string;
  headOid: string;
  child?: ReviewState["child"];
  pages: readonly WalkthroughPage[];
  counts: {
    changedFiles: number;
    anchoredFindings: number;
    unanchoredFindings: number;
    selectedFindings: number;
    invalidAnchors: number;
  };
  notice?: WalkthroughNotice;
  actionResult?: WalkthroughActionResult;
}>;

export type WalkthroughPage = DeepReadonly<
  | { id: string; kind: "overview"; title: string; lines: readonly string[] }
  | { id: string; kind: "file"; title: string; path: string; lines: readonly string[] }
  | { id: string; kind: "finding"; title: string; findingId: string; lines: readonly string[] }
  | { id: string; kind: "unanchored"; title: string; lines: readonly string[] }
  | { id: string; kind: "finalize"; title: string; lines: readonly string[] }
>;

export interface WalkthroughDiffContext {
  readonly before?: readonly string[];
  readonly lines: readonly string[];
  readonly after?: readonly string[];
}

export interface WalkthroughOptions {
  readonly diffContextByFindingId?: ReadonlyMap<string, WalkthroughDiffContext>;
  readonly notice?: WalkthroughNotice;
  readonly actionResult?: WalkthroughActionResult;
}

function findingId(finding: Finding, index: number): string {
  return finding.id ?? `F${index + 1}`;
}

function findingAnchor(finding: Finding): string | undefined {
  if (!finding.file) return undefined;
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function findingSummary(finding: Finding, index: number, selectedIds: ReadonlySet<string>): string {
  const id = findingId(finding, index);
  const anchor = findingAnchor(finding) ?? "post-body note";
  const mark = selectedIds.has(id) ? "selected" : "not selected";
  const valid = finding.anchorValid !== true ? ", unanchored/post-body" : "";
  return `${id} ${finding.severity}/${finding.impact} ${anchor} (${mark}${valid}) — ${finding.problem}`;
}

function selectedCount(findings: readonly Finding[], selectedIds: ReadonlySet<string>): number {
  return findings.filter((f, index) => selectedIds.has(findingId(f, index))).length;
}

function pushBlock(lines: string[], label: string, value: string | undefined): void {
  if (!value) return;
  lines.push(`${label}: ${value}`);
}

function findingDetailLines(
  finding: Finding,
  index: number,
  context: WalkthroughDiffContext | undefined,
  selectedIds: ReadonlySet<string>,
): string[] {
  const lines = [findingSummary(finding, index, selectedIds)];
  pushBlock(lines, "Problem", finding.problem);
  pushBlock(lines, "Consequence", finding.consequence);
  pushBlock(lines, "Suggested fix", finding.suggestedFix);
  if (!finding.file) {
    lines.push("Post-body explanation: this finding is not tied to a GitHub diff line.");
  } else if (context) {
    lines.push("Bounded diff context:");
    for (const line of [...(context.before ?? []), ...context.lines, ...(context.after ?? [])]) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push("Bounded diff context: not supplied by caller.");
  }
  return lines;
}

type FindingEntry = { finding: Finding; index: number; id: string };

type FindingGroups = {
  findings: readonly Finding[];
  anchored: FindingEntry[];
  unanchored: FindingEntry[];
  selectedIds: ReadonlySet<string>;
  invalidAnchors: number;
};

function findingEntries(findings: readonly Finding[]): FindingEntry[] {
  return findings.map((finding, index) => ({ finding, index, id: findingId(finding, index) }));
}

function groupFindings(state: ReviewState): FindingGroups {
  const findings = state.result?.findings ?? [];
  const entries = findingEntries(findings);
  return {
    findings,
    anchored: entries.filter(({ finding }) => finding.anchorValid === true && finding.file),
    unanchored: entries.filter(({ finding }) => finding.anchorValid !== true || !finding.file),
    selectedIds: new Set(state.selectedFindingIds),
    invalidAnchors: findings.filter((f) => f.anchorValid === false).length,
  };
}

function overviewPage(state: ReviewState, complete: boolean): WalkthroughPage {
  const meta = state.snapshot.metadata;
  return {
    id: "overview",
    kind: "overview",
    title: "Review overview",
    lines: [
      `PR: ${meta.owner}/${meta.repo}#${meta.number}`,
      `URL: ${meta.url}`,
      `Reviewed head: ${meta.headOid}`,
      `Title: ${meta.title ?? "(untitled)"}`,
      `Goal: ${state.plan?.goal ?? "No accepted review plan yet."}`,
      `Goal assessment: ${state.plan?.goalAssessment ?? "No accepted review plan yet."}`,
      `Risk: ${state.plan?.risk ?? "unknown"}`,
      `Risk reasons: ${state.plan?.riskReasons?.join(", ") || "none"}`,
      `Verdict: ${state.result?.verdict ?? "No submitted review result yet."}`,
      `Preface: ${state.preface?.trim() ? state.preface.trim() : "(none)"}`,
      `Changed files: ${meta.changedFiles.length}`,
      complete
        ? "State: complete"
        : "State: incomplete; posting is blocked until plan and result exist.",
    ],
  };
}

function filePage(
  path: string,
  cohortLabel: string,
  pathFindings: FindingEntry[],
  planFile: PlanFile | undefined,
  selectedIds: ReadonlySet<string>,
): WalkthroughPage {
  return {
    id: `file:${path}`,
    kind: "file",
    title: path,
    path,
    lines: [
      `Cohort: ${cohortLabel}`,
      `Attention: ${planFile?.attention ?? "unplanned"}`,
      `Role: ${planFile?.role ?? "changed file without plan entry"}`,
      pathFindings.length ? "Findings:" : "Findings: none",
      ...pathFindings.map(({ finding, index }) => `- ${findingSummary(finding, index, selectedIds)}`),
    ],
  };
}

function findingPage(
  path: string,
  entry: FindingEntry,
  options: WalkthroughOptions,
  selectedIds: ReadonlySet<string>,
): WalkthroughPage {
  return {
    id: `finding:${entry.id}`,
    kind: "finding",
    title: `${entry.id} ${path}`,
    findingId: entry.id,
    lines: findingDetailLines(
      entry.finding,
      entry.index,
      options.diffContextByFindingId?.get(entry.id),
      selectedIds,
    ),
  };
}

function appendFilePages(
  pages: WalkthroughPage[],
  state: ReviewState,
  groups: FindingGroups,
  options: WalkthroughOptions,
): void {
  const planFileByPath = new Map((state.plan?.files ?? []).map((file) => [file.path, file]));
  const emitted = new Set<string>();
  const append = (path: string, cohortLabel: string): void => {
    if (emitted.has(path)) return;
    emitted.add(path);
    const pathFindings = groups.anchored.filter(({ finding }) => finding.file === path);
    pages.push(filePage(path, cohortLabel, pathFindings, planFileByPath.get(path), groups.selectedIds));
    pages.push(...pathFindings.map((entry) => findingPage(path, entry, options, groups.selectedIds)));
  };
  for (const cohort of state.plan?.cohorts ?? []) {
    for (const path of cohort.paths) append(path, cohort.label);
  }
  for (const file of state.snapshot.metadata.changedFiles) append(file.path, "changed files");
}

function unanchoredPage(entries: FindingEntry[], selectedIds: ReadonlySet<string>): WalkthroughPage {
  return {
    id: "unanchored",
    kind: "unanchored",
    title: "Post-body findings",
    lines: entries.flatMap(({ finding, index }) => [
      findingSummary(finding, index, selectedIds),
      "Post-body reason: no valid line is available in the pinned diff.",
      `Problem: ${finding.problem}`,
      `Consequence: ${finding.consequence}`,
      `Suggested fix: ${finding.suggestedFix}`,
    ]),
  };
}

function selectedFindingStats(groups: FindingGroups): { selected: Finding[]; selectedAnchored: number } {
  const selected = groups.findings.filter((finding, index) =>
    groups.selectedIds.has(findingId(finding, index)),
  );
  const selectedAnchored = selected.filter(
    (finding) => finding.anchorValid === true && finding.file,
  ).length;
  return { selected, selectedAnchored };
}

function finalizePage(
  state: ReviewState,
  groups: FindingGroups,
  complete: boolean,
  actionResult: WalkthroughActionResult | undefined,
): WalkthroughPage {
  const { selected, selectedAnchored } = selectedFindingStats(groups);
  const selectedPostBody = selected.length - selectedAnchored;
  const meta = state.snapshot.metadata;
  return {
    id: "finalize",
    kind: "finalize",
    title: "Finalize review",
    lines: [
      `Reviewed head: ${meta.headOid}`,
      `Preface: ${state.preface?.trim() ? state.preface.trim() : "(none)"}`,
      `Selected anchored findings: ${selectedAnchored}/${groups.anchored.length}`,
      `Selected post-body findings: ${selectedPostBody}/${groups.unanchored.length}`,
      `Selected findings: ${selected.length}/${groups.findings.length}`,
      `Anchored findings: ${groups.anchored.length}`,
      `Post-body findings: ${groups.unanchored.length}`,
      groups.unanchored.length
        ? "Unanchored reason: invalid, missing, or file-only anchors are posted in the review body."
        : "Unanchored reason: none.",
      `Invalid anchors: ${groups.invalidAnchors}`,
      `Posts: ${state.posts.length}`,
      complete
        ? "Posting: available after explicit event choice and confirmation"
        : "Posting: blocked until plan and result exist",
      state.child
        ? `Child session: ${state.child.sessionName ?? state.child.sessionFile ?? "available"}${state.child.isError ? " (error)" : ""}`
        : "Child session: missing",
      actionResult
        ? `Last action: ${actionResult.action} ${actionResult.ok ? "ok" : "failed"} — ${actionResult.notice.message}`
        : "Last action: none",
    ],
  };
}

export function deriveWalkthroughViewModel(
  state: ReviewState,
  options: WalkthroughOptions = {},
): WalkthroughViewModel {
  const meta = state.snapshot.metadata;
  const complete = Boolean(state.plan && state.result);
  const groups = groupFindings(state);
  const pages: WalkthroughPage[] = [overviewPage(state, complete)];
  if (complete) appendFilePages(pages, state, groups, options);
  if (complete && groups.unanchored.length) pages.push(unanchoredPage(groups.unanchored, groups.selectedIds));
  pages.push(finalizePage(state, groups, complete, options.actionResult));
  return Object.freeze({
    reviewId: state.snapshot.id,
    title: `PR review ${meta.owner}/${meta.repo}#${meta.number}`,
    url: meta.url,
    headOid: meta.headOid,
    child: state.child,
    pages,
    counts: {
      changedFiles: meta.changedFiles.length,
      anchoredFindings: groups.anchored.length,
      unanchoredFindings: groups.unanchored.length,
      selectedFindings: selectedCount(groups.findings, groups.selectedIds),
      invalidAnchors: groups.invalidAnchors,
    },
    notice: options.notice,
    actionResult: options.actionResult,
  });
}

export interface WalkthroughComponentOptions {
  readonly viewModel: WalkthroughViewModel;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly rows?: number;
  readonly onIntent?: (intent: WalkthroughIntent) => void;
  readonly requestRender?: () => void;
  readonly theme?: {
    fg?: (color: string, text: string) => string;
    bold?: (text: string) => string;
  };
}

export class PrReviewWalkthroughComponent implements Component {
  private selected = 0;
  private scroll = 0;
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private lastBodyRows = 1;
  private lastBodyRowCount = 0;
  private themeGeneration = 0;

  constructor(private readonly options: WalkthroughComponentOptions) {}

  handleInput(data: string): void {
    const handler = this.inputHandlers(this.currentFindingId()).find(({ matches }) => matches(data));
    handler?.run();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const maxRows = Math.max(3, this.options.rows ?? 18);
    const safeWidth = Math.max(1, width);
    const lines =
      safeWidth < 40
        ? this.renderFallback(safeWidth, maxRows)
        : this.renderFull(safeWidth, maxRows);
    this.cachedWidth = width;
    this.cachedRows = lines.map((line) => truncateToWidth(line, safeWidth, ""));
    return this.cachedRows;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.themeGeneration += 1;
  }

  themeInvalidationCount(): number {
    return this.themeGeneration;
  }

  private page(): WalkthroughPage {
    return this.options.viewModel.pages[this.selected] ?? this.options.viewModel.pages[0]!;
  }

  private currentFindingId(): string | undefined {
    const page = this.page();
    return page.kind === "finding" ? page.findingId : undefined;
  }

  private inputHandlers(findingId: string | undefined): Array<{ matches: (data: string) => boolean; run: () => void }> {
    const kb = this.options.keybindings;
    return [
      { matches: (data) => matchesKey(data, Key.left), run: () => this.movePage(-1) },
      { matches: (data) => matchesKey(data, Key.right), run: () => this.movePage(1) },
      { matches: (data) => kb.matches(data, "tui.select.up"), run: () => this.scrollBy(-1) },
      { matches: (data) => kb.matches(data, "tui.select.down"), run: () => this.scrollBy(1) },
      {
        matches: (data) => kb.matches(data, "tui.select.pageUp"),
        run: () => this.scrollBy(-this.lastBodyRows),
      },
      {
        matches: (data) => kb.matches(data, "tui.select.pageDown"),
        run: () => this.scrollBy(this.lastBodyRows),
      },
      { matches: (data) => kb.matches(data, "tui.select.confirm"), run: () => this.handleEnter() },
      { matches: (data) => kb.matches(data, "tui.select.cancel"), run: () => this.emit({ kind: "cancel" }) },
      {
        matches: (data) => matchesKey(data, Key.space) && Boolean(findingId),
        run: () => this.emit({ kind: "toggleSelection", findingId: findingId! }),
      },
      { matches: (data) => data === "e", run: () => this.emit({ kind: "edit", findingId }) },
      { matches: (data) => data === "f", run: () => this.emit({ kind: "editPreface" }) },
      { matches: (data) => data === "r", run: () => this.emit({ kind: "rerun" }) },
      { matches: (data) => data === "p", run: () => this.emit({ kind: "post" }) },
      { matches: (data) => data === "i", run: () => this.emit({ kind: "inspectChild" }) },
      { matches: (data) => data === "c", run: () => this.emit({ kind: "cleanup" }) },
      { matches: (data) => data === "?", run: () => this.emit({ kind: "help" }) },
    ];
  }

  private handleEnter(): void {
    const page = this.page();
    if (page.kind === "finding")
      return this.emit({ kind: "toggleSelection", findingId: page.findingId });
    if (page.kind === "finalize") return this.emit({ kind: "post" });
    this.movePage(1);
  }

  private movePage(delta: number): void {
    const last = Math.max(0, this.options.viewModel.pages.length - 1);
    const next = Math.max(0, Math.min(last, this.selected + delta));
    if (next !== this.selected) {
      this.selected = next;
      this.scroll = 0;
      this.invalidate();
      this.options.requestRender?.();
    }
  }

  private scrollBy(delta: number): void {
    const maxScroll = this.maxScroll();
    const next = Math.max(0, Math.min(maxScroll, this.scroll + delta));
    if (next !== this.scroll) {
      this.scroll = next;
      this.invalidate();
      this.options.requestRender?.();
    }
  }

  private maxScroll(): number {
    if (this.cachedWidth !== undefined) this.render(this.cachedWidth);
    return Math.max(0, this.lastBodyRowCount - this.lastBodyRows);
  }

  private emit(intent: WalkthroughIntent): void {
    this.options.onIntent?.(intent);
  }

  private style(color: string, text: string): string {
    return this.options.theme?.fg?.(color, text) ?? text;
  }

  private renderFallback(width: number, rows: number): string[] {
    const page = this.page();
    this.lastBodyRows = Math.max(1, rows - 3);
    this.lastBodyRowCount = 0;
    this.scroll = 0;
    return this.boundRows(
      [
        this.style("accent", truncateToWidth("PR review", width, "")),
        truncateToWidth(
          `${this.selected + 1}/${this.options.viewModel.pages.length} ${page.title}`,
          width,
          "",
        ),
        truncateToWidth("Resize to 40+ columns, or press Esc to close.", width, ""),
      ],
      rows,
    );
  }

  private renderFull(width: number, rows: number): string[] {
    const page = this.page();
    const bodyWidth = Math.max(10, width - 2);
    const header = this.style(
      "accent",
      this.options.theme?.bold?.(this.options.viewModel.title) ?? this.options.viewModel.title,
    );
    const nav = `${this.selected + 1}/${this.options.viewModel.pages.length} ${page.kind}: ${page.title}`;
    const headerRows = [
      header,
      this.style("muted", nav),
      ...(this.options.viewModel.notice
        ? [this.style(this.options.viewModel.notice.kind, this.options.viewModel.notice.message)]
        : []),
      "",
    ];
    const footerRows = [
      "",
      this.style(
        "dim",
        "←/→ section • ↑↓/Pg scroll • Enter select/next/post • Esc close • Space select • e edit • f preface • r rerun • p post • i child • c cleanup • ? help",
      ),
    ];
    const body = page.lines.flatMap((line) =>
      wrapTextWithAnsi(line, bodyWidth).map((wrapped) => ` ${wrapped}`),
    );
    const bodyRows = Math.max(1, rows - headerRows.length - footerRows.length);
    this.lastBodyRows = bodyRows;
    this.lastBodyRowCount = body.length;
    const maxScroll = Math.max(0, body.length - bodyRows);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const visibleBody = body.slice(this.scroll, this.scroll + bodyRows);
    while (visibleBody.length < bodyRows) visibleBody.push("");
    return this.boundRows([...headerRows, ...visibleBody, ...footerRows], rows);
  }

  private boundRows(lines: string[], rows: number): string[] {
    const bounded = lines.slice(0, rows);
    while (bounded.length < Math.min(rows, 3)) bounded.push("");
    return bounded;
  }
}

export function createPrReviewWalkthroughComponent(
  options: WalkthroughComponentOptions,
): PrReviewWalkthroughComponent {
  return new PrReviewWalkthroughComponent(options);
}
