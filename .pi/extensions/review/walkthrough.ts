import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { bound, type Finding, type ReviewState } from "./core";
import { decisionFor, isDegraded } from "./decision";
import {
  createWalkthroughContext,
  pinnedContext,
  type WalkthroughContext,
} from "./walkthrough-context";

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

function coverageStatus(state: ReviewState): string {
  if (isDegraded(state)) return "degraded";
  if (state.dag?.status === "running") return "running";
  if (!state.plan || !state.result) return "unavailable";
  return state.result.coverage?.status ?? "unavailable";
}

function coverageText(state: ReviewState): string {
  const omissions = state.dag?.evidenceCoverage?.omissions ?? state.plan?.evidenceOmissions ?? [];
  return [
    `Coverage: ${coverageStatus(state)}`,
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

async function detail(
  select: ExtensionCommandContext["ui"]["select"],
  text: string,
): Promise<void> {
  const total = Math.max(1, Math.ceil(text.length / 5_000));
  let page = 0;
  while (true) {
    const choice = await select(
      `${text.slice(page * 5_000, (page + 1) * 5_000) || "(empty detail)"}\n\nPage ${page + 1}/${total}`,
      [...(page > 0 ? ["Previous"] : []), ...(page + 1 < total ? ["Next"] : []), "Back"],
    );
    if (choice === "Previous") page -= 1;
    else if (choice === "Next") page += 1;
    else return;
  }
}

async function inspectFinding(
  select: ExtensionCommandContext["ui"]["select"],
  actions: WalkthroughActions,
  evidence: WalkthroughContext,
  findingId: string,
): Promise<void> {
  while (true) {
    const choice = await select(evidence.finding(findingId), [
      "Select for posting",
      "Reject",
      "Defer",
      "Edit presentation",
      "Back",
    ]);
    if (!choice || choice === "Back") return;
    const message =
      choice === "Edit presentation"
        ? await actions.editFinding(findingId)
        : await actions.decide(
            findingId,
            choice === "Reject" ? "rejected" : choice === "Defer" ? "deferred" : "selected",
          );
    await detail(select, message);
  }
}

async function inspectFiles(
  select: ExtensionCommandContext["ui"]["select"],
  actions: WalkthroughActions,
  evidence: WalkthroughContext,
) {
  while (true) {
    const files = planFiles(actions.state());
    const options = files.map(
      (file, index) => `${index + 1}. ${file.path} [${file.attention}] - ${file.role}`,
    );
    const choice = await select(`Reading plan: ${files.length} ordered file(s)`, [
      ...options,
      "Back",
    ]);
    if (!choice || choice === "Back") return;
    const file = files[options.indexOf(choice)];
    if (!file) continue;
    await detail(
      select,
      `${file.path}\nAttention: ${file.attention}\nRole: ${file.role}\nPinned diff is hash verified.\n${evidence.fileDiff(file.path)}`,
    );
  }
}

async function inspectFindings(
  select: ExtensionCommandContext["ui"]["select"],
  actions: WalkthroughActions,
  evidence: WalkthroughContext,
) {
  while (true) {
    const state = actions.state();
    const findings = state.result?.findings ?? [];
    const options = findings.map(
      (finding, index) => `${index + 1}. ${findingLine(state, finding)}`,
    );
    const choice = await select("Findings (anchored and unanchored)", [...options, "Back"]);
    if (!choice || choice === "Back") return;
    const finding = findings[options.indexOf(choice)];
    if (finding?.id) await inspectFinding(select, actions, evidence, finding.id);
  }
}

async function inspectProvenance(
  select: ExtensionCommandContext["ui"]["select"],
  actions: WalkthroughActions,
) {
  while (true) {
    const provenance = actions.state().result?.provenance;
    if (!provenance) {
      await detail(select, "Legacy provenance unavailable. No raw IDs were fabricated.");
      return;
    }
    const raw = provenance.rawFindings.map((item) => `${item.id} [${item.role}] #${item.index}`);
    const dismissed = provenance.dismissals.map(
      (item) => `Dismissed ${item.rawFindingId}: ${item.reason}`,
    );
    const options = [...raw, ...dismissed];
    const choice = await select("Provenance and dispositions", [...options, "Back"]);
    if (!choice || choice === "Back") return;
    const index = options.indexOf(choice);
    const record = provenance.rawFindings[index];
    await detail(
      select,
      record
        ? await actions.rawFinding(record.id)
        : (dismissed[index - raw.length] ?? "Unavailable"),
    );
  }
}

export async function guidedWalkthrough(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
): Promise<string> {
  const select: ExtensionCommandContext["ui"]["select"] = async (...args) => {
    actions.assertCurrent();
    const choice = await ctx.ui.select(...args);
    actions.assertCurrent();
    return choice;
  };
  const evidence = createWalkthroughContext(actions.state);
  const stageActions: Record<string, () => Promise<void>> = {
    "Overview and coverage": () =>
      detail(select, `${pinnedContext(actions.state())}\n${coverageText(actions.state())}`),
    "Reading plan": () => inspectFiles(select, actions, evidence),
    Findings: () => inspectFindings(select, actions, evidence),
    Provenance: () => inspectProvenance(select, actions),
    "Edit preface": async () => detail(select, await actions.editPreface()),
  };
  while (true) {
    const choice = await select(`PR review walkthrough ${actions.state().snapshot.id}`, [
      ...Object.keys(stageActions),
      "Exit",
    ]);
    const run = choice ? stageActions[choice] : undefined;
    if (!run) return walkthroughSummary(actions.state(), true);
    await run();
  }
}
