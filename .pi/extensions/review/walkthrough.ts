import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { bound, type Finding, type ReviewState } from "./core";
import { decisionFor, isDegraded } from "./decision";
import { findingContext, pinnedContext, pinnedDiffPages } from "./walkthrough-context";

type WalkthroughFile = NonNullable<ReviewState["plan"]>["files"][number];

function planFiles(state: ReviewState): readonly WalkthroughFile[] {
  return (
    state.plan?.files ??
    state.snapshot.metadata.changedFiles.map((file) => ({
      path: file.path,
      attention: "normal" as const,
      role: "Reading plan unavailable. Changed-file manifest entry.",
    }))
  );
}

function findingLine(state: ReviewState, finding: Finding): string {
  const recommendation = finding.selected ? " recommended" : "";
  const anchor = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : "unanchored";
  return bound(
    `${finding.id} [${decisionFor(state, finding.id!).status}]${recommendation} ${anchor} - ${finding.problem}`,
    280,
  );
}

function coverageText(state: ReviewState): string {
  const omissions = state.dag?.evidenceCoverage?.omissions ?? state.plan?.evidenceOmissions ?? [];
  return [
    `Coverage: ${state.result?.coverage?.status ?? state.dag?.status ?? "unavailable"}`,
    `Evidence omissions: ${omissions.join(", ") || "none"}`,
    `Failed nodes: ${state.dag?.failedNodes?.join(", ") || "none"}`,
    `Malformed nodes: ${state.dag?.malformedNodes?.join(", ") || "none"}`,
    `Fallback: ${state.result?.provenance?.status === "fallback" ? (state.result.provenance.fallbackReason ?? "used") : "none"}`,
  ].join("\n");
}

function boundedIndex(label: string, lines: readonly string[]): string {
  return `${label} (${lines.length} total)\n${bound(lines.join("\n") || "None", 1_000)}`;
}

export function walkthroughSummary(state: ReviewState, interactive: boolean): string {
  const findings = state.result?.findings ?? [];
  const provenance = state.result?.provenance;
  return bound(
    [
      `Walkthrough: ${state.snapshot.id}`,
      pinnedContext(state),
      coverageText(state),
      boundedIndex(
        "Reading plan",
        planFiles(state).map(
          (file, index) => `${index + 1}. ${file.path} [${file.attention}] - ${file.role}`,
        ),
      ),
      boundedIndex(
        "Findings",
        findings.map((finding) => findingLine(state, finding)),
      ),
      provenance
        ? `Provenance: ${provenance.rawFindings.length} raw finding(s), ${provenance.dismissals.length} dismissal(s), ${provenance.status}`
        : "Legacy provenance unavailable. No provenance was fabricated.",
      isDegraded(state) ? "Coverage is degraded; posting confirmation will show a warning." : "Coverage is complete.",
      interactive
        ? "Interactive inspection and decisions are available. Posting remains a separate explicit confirmation."
        : `Interactive decisions unavailable. Rerun: /review pr walkthrough ${state.snapshot.id}`,
    ].join("\n"),
    12_000,
  );
}

interface WalkthroughActions {
  readonly state: () => ReviewState;
  readonly assertCurrent: () => void;
  readonly decide: (
    findingId: string,
    status: "selected" | "rejected" | "deferred",
  ) => Promise<string>;
  readonly editFinding: (findingId: string) => Promise<string>;
  readonly editPreface: () => Promise<string>;
  readonly rawFinding: (rawFindingId: string) => Promise<string>;
}

async function detail(ctx: ExtensionCommandContext, text: string): Promise<void> {
  const pages = text.match(/[\s\S]{1,5000}/gu) ?? ["(empty detail)"];
  let page = 0;
  while (true) {
    const choice = await ctx.ui.select(`${pages[page]}\n\nPage ${page + 1}/${pages.length}`, [
      ...(page > 0 ? ["Previous"] : []),
      ...(page + 1 < pages.length ? ["Next"] : []),
      "Back",
    ]);
    if (choice === "Previous") page -= 1;
    else if (choice === "Next") page += 1;
    else return;
  }
}

async function inspectFinding(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
  findingId: string,
): Promise<void> {
  while (true) {
    actions.assertCurrent();
    const choice = await ctx.ui.select(findingContext(actions.state(), findingId), [
      "Select for posting",
      "Reject",
      "Defer",
      "Edit presentation",
      "Back",
    ]);
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const message =
      choice === "Edit presentation"
        ? await actions.editFinding(findingId)
        : await actions.decide(
            findingId,
            choice === "Reject" ? "rejected" : choice === "Defer" ? "deferred" : "selected",
          );
    actions.assertCurrent();
    await detail(ctx, message);
  }
}

async function inspectFiles(ctx: ExtensionCommandContext, actions: WalkthroughActions) {
  while (true) {
    const files = planFiles(actions.state());
    const options = files.map(
      (file, index) => `${index + 1}. ${file.path} [${file.attention}] - ${file.role}`,
    );
    const choice = await ctx.ui.select(`Reading plan: ${files.length} ordered file(s)`, [
      ...options,
      "Back",
    ]);
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const file = files[options.indexOf(choice)];
    if (!file) continue;
    const pages = pinnedDiffPages(actions.state(), file.path);
    await detail(
      ctx,
      `${file.path}\nAttention: ${file.attention}\nRole: ${file.role}\nPinned diff is hash verified.\n${pages.map((page) => `Page ${page.number}/${page.total}\n${page.text}`).join("\n")}`,
    );
  }
}

async function inspectFindings(ctx: ExtensionCommandContext, actions: WalkthroughActions) {
  while (true) {
    const state = actions.state();
    const findings = state.result?.findings ?? [];
    const options = findings.map((finding, index) => `${index + 1}. ${findingLine(state, finding)}`);
    const choice = await ctx.ui.select("Findings (anchored and unanchored)", [...options, "Back"]);
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const finding = findings[options.indexOf(choice)];
    if (finding?.id) await inspectFinding(ctx, actions, finding.id);
  }
}

async function inspectProvenance(ctx: ExtensionCommandContext, actions: WalkthroughActions) {
  while (true) {
    const provenance = actions.state().result?.provenance;
    if (!provenance) {
      await detail(ctx, "Legacy provenance unavailable. No raw IDs were fabricated.");
      return;
    }
    const raw = provenance.rawFindings.map((item) => `${item.id} [${item.role}] #${item.index}`);
    const dismissed = provenance.dismissals.map(
      (item) => `Dismissed ${item.rawFindingId}: ${item.reason}`,
    );
    const options = [...raw, ...dismissed];
    const choice = await ctx.ui.select("Provenance and dispositions", [...options, "Back"]);
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const index = options.indexOf(choice);
    const record = provenance.rawFindings[index];
    await detail(ctx, record ? await actions.rawFinding(record.id) : (dismissed[index - raw.length] ?? "Unavailable"));
  }
}

export async function guidedWalkthrough(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
): Promise<string> {
  const stages = ["Overview and coverage", "Reading plan", "Findings", "Provenance", "Edit preface", "Exit"];
  while (true) {
    actions.assertCurrent();
    const state = actions.state();
    const stageActions: Record<string, () => Promise<void>> = {
      "Overview and coverage": () => detail(ctx, `${pinnedContext(state)}\n${coverageText(state)}`),
      "Reading plan": () => inspectFiles(ctx, actions),
      Findings: () => inspectFindings(ctx, actions),
      Provenance: () => inspectProvenance(ctx, actions),
      "Edit preface": async () => detail(ctx, await actions.editPreface()),
    };
    const choice = await ctx.ui.select(`PR review walkthrough ${state.snapshot.id}`, stages);
    actions.assertCurrent();
    const run = choice ? stageActions[choice] : undefined;
    if (!run) return walkthroughSummary(actions.state(), true);
    await run();
  }
}
