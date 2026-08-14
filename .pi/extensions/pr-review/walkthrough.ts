import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Finding, ReviewState } from "./core";

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
  action: "select" | "edit" | "preface" | "rerun" | "post" | "inspect" | "cleanup";
  ok: boolean;
  notice: WalkthroughNotice;
}>;

export type WalkthroughIntent =
  | { kind: "navigate"; direction: "left" | "right" }
  | { kind: "scroll"; direction: "up" | "down" | "pageUp" | "pageDown" }
  | { kind: "confirm"; pageId: string }
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

export function deriveWalkthroughViewModel(
  state: ReviewState,
  options: WalkthroughOptions = {},
): WalkthroughViewModel {
  const meta = state.snapshot.metadata;
  const findings = state.result?.findings ?? [];
  const selectedIds = new Set(state.selectedFindingIds);
  const complete = Boolean(state.plan && state.result);
  const anchored = findings
    .map((finding, index) => ({ finding, index, id: findingId(finding, index) }))
    .filter(({ finding }) => finding.anchorValid === true && finding.file);
  const unanchored = findings
    .map((finding, index) => ({ finding, index, id: findingId(finding, index) }))
    .filter(({ finding }) => finding.anchorValid !== true || !finding.file);
  const pages: WalkthroughPage[] = [];

  pages.push({
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
      `Risk reasons: ${state.plan?.riskReasons?.join("; ") || "none"}`,
      `Verdict: ${state.result?.verdict ?? "No submitted review result yet."}`,
      `Preface: ${state.preface?.trim() ? state.preface.trim() : "(none)"}`,
      `Changed files: ${meta.changedFiles.length}`,
      complete ? "State: complete" : "State: incomplete; posting is blocked until plan and result exist.",
    ],
  });

  const planFileByPath = new Map((state.plan?.files ?? []).map((file) => [file.path, file]));
  const emitted = new Set<string>();
  const appendFilePage = (path: string, cohortLabel: string): void => {
    if (emitted.has(path)) return;
    emitted.add(path);
    const planFile = planFileByPath.get(path);
    const pathFindings = anchored.filter(({ finding }) => finding.file === path);
    pages.push({
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
    });
    for (const { finding, index, id } of pathFindings) {
      pages.push({
        id: `finding:${id}`,
        kind: "finding",
        title: `${id} ${path}`,
        findingId: id,
        lines: findingDetailLines(finding, index, options.diffContextByFindingId?.get(id), selectedIds),
      });
    }
  };

  if (complete) {
    for (const cohort of state.plan?.cohorts ?? []) {
      for (const path of cohort.paths) appendFilePage(path, cohort.label);
    }
    for (const file of meta.changedFiles) appendFilePage(file.path, "changed files");
  }

  if (unanchored.length) {
    pages.push({
      id: "unanchored",
      kind: "unanchored",
      title: "Post-body findings",
      lines: unanchored.flatMap(({ finding, index }) => [
        findingSummary(finding, index, selectedIds),
        `Post-body explanation: ${finding.problem}`,
        `Consequence: ${finding.consequence}`,
        `Suggested fix: ${finding.suggestedFix}`,
      ]),
    });
  }

  const invalidAnchors = findings.filter((f) => f.anchorValid === false).length;
  pages.push({
    id: "finalize",
    kind: "finalize",
    title: "Finalize review",
    lines: [
      `Selected findings: ${selectedCount(findings, selectedIds)}/${findings.length}`,
      `Anchored findings: ${anchored.length}`,
      `Post-body findings: ${unanchored.length}`,
      `Invalid anchors: ${invalidAnchors}`,
      `Posts: ${state.posts.length}`,
      `Preface: ${state.preface?.trim() ? state.preface.trim() : "(none)"}`,
      complete ? "Posting: available after explicit event choice and confirmation" : "Posting: blocked until plan and result exist",
      state.child
        ? `Child session: ${state.child.sessionName ?? state.child.sessionFile ?? "available"}${state.child.isError ? " (error)" : ""}`
        : "Child session: missing",
      options.actionResult
        ? `Last action: ${options.actionResult.action} ${options.actionResult.ok ? "ok" : "failed"} — ${options.actionResult.notice.message}`
        : "Last action: none",
    ],
  });

  return Object.freeze({
    reviewId: state.snapshot.id,
    title: `PR review ${meta.owner}/${meta.repo}#${meta.number}`,
    url: meta.url,
    headOid: meta.headOid,
    child: state.child,
    pages,
    counts: {
      changedFiles: meta.changedFiles.length,
      anchoredFindings: anchored.length,
      unanchoredFindings: unanchored.length,
      selectedFindings: selectedCount(findings, selectedIds),
      invalidAnchors,
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
  private themeGeneration = 0;

  constructor(private readonly options: WalkthroughComponentOptions) {}

  handleInput(data: string): void {
    const kb = this.options.keybindings;
    if (matchesKey(data, Key.left)) return this.movePage(-1, "left");
    if (matchesKey(data, Key.right)) return this.movePage(1, "right");
    if (kb.matches(data, "tui.select.up")) return this.scrollBy(-1, "up");
    if (kb.matches(data, "tui.select.down")) return this.scrollBy(1, "down");
    if (kb.matches(data, "tui.select.pageUp")) return this.scrollBy(-5, "pageUp");
    if (kb.matches(data, "tui.select.pageDown")) return this.scrollBy(5, "pageDown");
    if (kb.matches(data, "tui.select.confirm"))
      return this.emit({ kind: "confirm", pageId: this.page().id });
    if (kb.matches(data, "tui.select.cancel")) return this.emit({ kind: "cancel" });

    const page = this.page();
    const findingId = page.kind === "finding" ? page.findingId : undefined;
    if (matchesKey(data, Key.space) && findingId)
      return this.emit({ kind: "toggleSelection", findingId });
    if (data === "e") return this.emit({ kind: "edit", findingId });
    if (data === "f") return this.emit({ kind: "editPreface" });
    if (data === "r") return this.emit({ kind: "rerun" });
    if (data === "p") return this.emit({ kind: "post" });
    if (data === "i") return this.emit({ kind: "inspectChild" });
    if (data === "c") return this.emit({ kind: "cleanup" });
    if (data === "?") return this.emit({ kind: "help" });
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

  private movePage(delta: number, direction: "left" | "right"): void {
    const last = Math.max(0, this.options.viewModel.pages.length - 1);
    const next = Math.max(0, Math.min(last, this.selected + delta));
    if (next !== this.selected) {
      this.selected = next;
      this.scroll = 0;
      this.invalidate();
      this.options.requestRender?.();
    }
    this.emit({ kind: "navigate", direction });
  }

  private scrollBy(delta: number, direction: "up" | "down" | "pageUp" | "pageDown"): void {
    const pageLineCount = this.page().lines.length + 6;
    const maxScroll = Math.max(0, pageLineCount - Math.max(3, this.options.rows ?? 18));
    const next = Math.max(0, Math.min(maxScroll, this.scroll + delta));
    if (next !== this.scroll) {
      this.scroll = next;
      this.invalidate();
      this.options.requestRender?.();
    }
    this.emit({ kind: "scroll", direction });
  }

  private emit(intent: WalkthroughIntent): void {
    this.options.onIntent?.(intent);
  }

  private style(color: string, text: string): string {
    return this.options.theme?.fg?.(color, text) ?? text;
  }

  private renderFallback(width: number, rows: number): string[] {
    const page = this.page();
    return this.boundRows(
      [
        this.style("accent", truncateToWidth("PR review", width, "")),
        truncateToWidth(
          `${this.selected + 1}/${this.options.viewModel.pages.length} ${page.title}`,
          width,
          "",
        ),
        truncateToWidth("Width too narrow; use 40+ columns.", width, ""),
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
    const raw = [
      header,
      this.style("muted", nav),
      ...(this.options.viewModel.notice
        ? [this.style(this.options.viewModel.notice.kind, this.options.viewModel.notice.message)]
        : []),
      "",
      ...page.lines.flatMap((line) =>
        wrapTextWithAnsi(line, bodyWidth).map((wrapped) => ` ${wrapped}`),
      ),
      "",
      this.style(
        "dim",
        "←/→ section • ↑↓/Pg scroll • Esc close • Space select • e edit • f preface • r rerun • p post • i child • c cleanup • ? help",
      ),
    ];
    return this.boundRows(raw, rows);
  }

  private boundRows(lines: string[], rows: number): string[] {
    const bounded = lines.slice(this.scroll, this.scroll + rows);
    while (bounded.length < Math.min(rows, 3)) bounded.push("");
    for (const line of bounded) {
      if (visibleWidth(line) > 10_000) break;
    }
    return bounded;
  }
}

export function createPrReviewWalkthroughComponent(
  options: WalkthroughComponentOptions,
): PrReviewWalkthroughComponent {
  return new PrReviewWalkthroughComponent(options);
}
