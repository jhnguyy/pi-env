import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { bound, type Finding, type ReviewState } from "./core";
import { decisionFor, finalizationStatus, hasCurrentAcknowledgement, isDegraded } from "./decision";
import { readRawFindingArtifact } from "./raw-provenance";
import { findingContext, pinnedContext, pinnedDiffPages } from "./walkthrough-context";

function findingLine(state: ReviewState, finding: Finding): string {
  const decision = decisionFor(state, finding.id!);
  const recommendation = finding.selected ? " recommended" : "";
  const anchor = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : "unanchored";
  return bound(
    `${finding.id} [${decision.status}]${recommendation} ${anchor} - ${finding.problem}`,
    280,
  );
}

type WalkthroughFile = NonNullable<ReviewState["plan"]>["files"][number];

function planFiles(state: ReviewState): readonly WalkthroughFile[] {
  return (
    state.plan?.files ??
    state.snapshot.metadata.changedFiles.map((file) => ({
      path: file.path,
      attention: "normal" as const,
      role: "Reading plan unavailable; changed-file manifest entry",
    }))
  );
}

function fileLine(index: number, file: WalkthroughFile): string {
  return bound(`${index + 1}. ${file.path} [${file.attention}] - ${file.role}`, 280);
}

function omissions(state: ReviewState): readonly string[] {
  return state.dag?.evidenceCoverage?.omissions ?? state.plan?.evidenceOmissions ?? [];
}

function coverageText(state: ReviewState, boundedOutput = false): string {
  const coverage = state.result?.coverage;
  const provenance = state.result?.provenance;
  const evidenceOmissions = omissions(state);
  const text = [
    "Coverage",
    `Status: ${coverage?.status ?? state.dag?.status ?? "unavailable"}`,
    `Evidence omissions (${evidenceOmissions.length}): ${evidenceOmissions.join(", ") || "none"}`,
    `Failed nodes: ${state.dag?.failedNodes?.join(", ") || "none"}`,
    `Malformed nodes: ${state.dag?.malformedNodes?.join(", ") || "none"}`,
    `Preparation failure: ${state.preparation ? `${state.preparation.stage}/${state.preparation.code}: ${state.preparation.message}` : "none"}`,
    `Fallback: ${provenance?.status === "fallback" ? (provenance.fallbackReason ?? "used") : "none"}`,
    `Usage: ${state.metrics?.usage?.turns ?? 0} turns, ${state.metrics?.usage?.input ?? 0} input, ${state.metrics?.usage?.output ?? 0} output`,
  ].join("\n");
  return boundedOutput ? bound(text, 1_500) : text;
}

function boundedIndex(label: string, lines: readonly string[], max = 1_000): string {
  const content = lines.join("\n") || "None";
  const rendered = bound(content, max);
  return `${label} (${lines.length} total)\n${rendered}${rendered !== content ? "\nUse the interactive index to inspect every item." : ""}`;
}

export function walkthroughSummary(state: ReviewState, interactive: boolean): string {
  const findings = state.result?.findings ?? [];
  const anchored = findings.filter((finding) => finding.anchorValid && finding.file);
  const unanchored = findings.filter((finding) => !finding.anchorValid || !finding.file);
  const provenance = state.result?.provenance;
  const files = planFiles(state);
  const lines = [
    `Walkthrough: ${state.snapshot.id}`,
    "Overview",
    pinnedContext(state),
    coverageText(state, true),
    boundedIndex(
      "Reading plan",
      files.map((file, index) => fileLine(index, file)),
    ),
    boundedIndex(
      "Anchored findings",
      anchored.map((finding) => findingLine(state, finding)),
    ),
    boundedIndex(
      "Unanchored findings",
      unanchored.map((finding) => findingLine(state, finding)),
    ),
    "Provenance and dispositions",
    provenance
      ? `${provenance.rawFindings.length} raw finding(s), ${provenance.dismissals.length} dismissal(s), ${provenance.status}`
      : "Legacy provenance unavailable. No provenance was fabricated.",
    boundedIndex(
      "Human decisions",
      findings.map((finding) => findingLine(state, finding)),
    ),
    "Finalize",
    `Finalization status: ${finalizationStatus(state)}`,
    isDegraded(state)
      ? `Degraded review acknowledgement: ${hasCurrentAcknowledgement(state) ? "current" : "required or stale"}`
      : "Review is not degraded.",
    interactive
      ? `Interactive inspection available. Finalize: /review pr finalize ${state.snapshot.id}`
      : `Interactive decisions and finalization unavailable. Rerun: /review pr walkthrough ${state.snapshot.id}`,
  ];
  return bound(lines.join("\n"), 12_000);
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
  readonly finalize: () => Promise<string>;
}

async function detail(ctx: ExtensionCommandContext, title: string): Promise<void> {
  const pageSize = 5_000;
  const pages: string[] = [];
  for (let offset = 0; offset < title.length; offset += pageSize)
    pages.push(title.slice(offset, offset + pageSize));
  if (pages.length === 0) pages.push("(empty detail)");
  let page = 0;
  while (true) {
    const options = [
      ...(page > 0 ? ["Previous page"] : []),
      ...(page + 1 < pages.length ? ["Next page"] : []),
      "Back",
    ];
    const choice = await ctx.ui.select(
      `${pages[page]}\n\nDetail page ${page + 1}/${pages.length}.`,
      options,
    );
    if (choice === "Next page") page += 1;
    else if (choice === "Previous page") page -= 1;
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
    const state = actions.state();
    const choice = await ctx.ui.select(findingContext(state, findingId), [
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

async function findingIndex(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
  anchored: boolean,
): Promise<void> {
  while (true) {
    const state = actions.state();
    const findings = (state.result?.findings ?? []).filter((finding) =>
      anchored
        ? Boolean(finding.anchorValid && finding.file)
        : !finding.anchorValid || !finding.file,
    );
    const options = [
      ...findings.map((finding, index) => `${index + 1}. ${findingLine(state, finding)}`),
      "Back",
    ];
    const choice = await ctx.ui.select(
      anchored ? "Anchored findings" : "Unanchored findings",
      options,
    );
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const index = options.indexOf(choice);
    const finding = findings[index];
    if (finding?.id) await inspectFinding(ctx, actions, finding.id);
  }
}

async function readingPlan(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
): Promise<void> {
  while (true) {
    const state = actions.state();
    const files = planFiles(state);
    const options = [...files.map((file, index) => fileLine(index, file)), "Back"];
    const choice = await ctx.ui.select(`Reading plan: ${files.length} ordered file(s)`, options);
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const file = files[options.indexOf(choice)];
    if (!file) continue;
    const pages = pinnedDiffPages(state, file.path);
    while (true) {
      const pageOptions = [
        ...pages.map((page) => `Pinned diff page ${page.number}/${page.total}`),
        "Back",
      ];
      const pageChoice = await ctx.ui.select(
        bound(
          `${file.path}\nAttention: ${file.attention}\nRole: ${file.role}\nPinned diff is hash verified. ${pages.length} bounded page(s).`,
          1_000,
        ),
        pageOptions,
      );
      actions.assertCurrent();
      if (!pageChoice || pageChoice === "Back") break;
      const page = pages[pageOptions.indexOf(pageChoice)];
      if (page)
        await detail(ctx, `${file.path} — pinned diff ${page.number}/${page.total}\n${page.text}`);
    }
  }
}

async function provenance(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
): Promise<void> {
  while (true) {
    const value = actions.state().result?.provenance;
    if (!value) {
      await detail(
        ctx,
        "Provenance and dispositions\nLegacy provenance unavailable. No raw IDs or human inspection were fabricated.",
      );
      return;
    }
    const rawOptions = value.rawFindings.map(
      (raw, index) => `Raw ${index + 1}: ${raw.id} [${raw.role}]`,
    );
    const dismissalOptions = value.dismissals.map(
      (item, index) => `Dismissal ${index + 1}: ${item.rawFindingId}`,
    );
    const options = [...rawOptions, ...dismissalOptions, "Back"];
    const choice = await ctx.ui.select(
      `Provenance and dispositions\nEditorial consolidation: ${value.status}. Every raw record and dismissal is listed.`,
      options,
    );
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    const index = options.indexOf(choice);
    if (index < rawOptions.length) {
      const raw = value.rawFindings[index];
      if (!raw) continue;
      const state = actions.state();
      const materialized = await Effect.runPromise(
        Effect.match(readRawFindingArtifact(state.snapshot.artifactDir, state.dag!.runId, raw), {
          onFailure: (error) => ({ available: false as const, error }),
          onSuccess: (finding) => ({ available: true as const, finding }),
        }),
      );
      actions.assertCurrent();
      await detail(
        ctx,
        materialized.available
          ? `Raw finding ${materialized.finding.id}\nRole: ${materialized.finding.role}\nEvidence digest: ${materialized.finding.evidenceDigest}\n${JSON.stringify(materialized.finding.finding, null, 2)}`
          : `Raw finding ${raw.id}\nRaw evidence unavailable or tampered: ${materialized.error.message}`,
      );
    } else {
      const dismissal = value.dismissals[index - rawOptions.length];
      if (dismissal)
        await detail(ctx, `Dismissed ${dismissal.rawFindingId}\nReason: ${dismissal.reason}`);
    }
  }
}

async function decisions(ctx: ExtensionCommandContext, actions: WalkthroughActions): Promise<void> {
  while (true) {
    const state = actions.state();
    const findings = state.result?.findings ?? [];
    const options = [
      ...findings.map((finding, index) => `${index + 1}. ${findingLine(state, finding)}`),
      "Edit preface",
      "Back",
    ];
    const choice = await ctx.ui.select(
      bound(`Human decisions\nPreface: ${state.preface?.trim() || "(none)"}`, 1_000),
      options,
    );
    actions.assertCurrent();
    if (!choice || choice === "Back") return;
    if (choice === "Edit preface") {
      await detail(ctx, await actions.editPreface());
      continue;
    }
    const finding = findings[options.indexOf(choice)];
    if (finding?.id) await inspectFinding(ctx, actions, finding.id);
  }
}

export async function guidedWalkthrough(
  ctx: ExtensionCommandContext,
  actions: WalkthroughActions,
): Promise<string> {
  const stages = [
    "1. Overview and coverage",
    "2. Reading plan and pinned file diffs",
    "3. Anchored findings",
    "4. Unanchored findings",
    "5. Provenance and dispositions",
    "6. Human decisions and preface",
    "7. Finalize",
    "Exit walkthrough",
  ];
  while (true) {
    actions.assertCurrent();
    const state = actions.state();
    const choice = await ctx.ui.select(
      `PR review walkthrough ${state.snapshot.id}\nChoose a stage. Stages are ordered and all indexed items remain reachable.`,
      stages,
    );
    actions.assertCurrent();
    switch (choice) {
      case "1. Overview and coverage":
        await detail(ctx, `Overview\n${pinnedContext(state)}\n${coverageText(state)}`);
        break;
      case "2. Reading plan and pinned file diffs":
        await readingPlan(ctx, actions);
        break;
      case "3. Anchored findings":
        await findingIndex(ctx, actions, true);
        break;
      case "4. Unanchored findings":
        await findingIndex(ctx, actions, false);
        break;
      case "5. Provenance and dispositions":
        await provenance(ctx, actions);
        break;
      case "6. Human decisions and preface":
        await decisions(ctx, actions);
        break;
      case "7. Finalize":
        await detail(ctx, await actions.finalize());
        break;
      default:
        return walkthroughSummary(actions.state(), true);
    }
  }
}
