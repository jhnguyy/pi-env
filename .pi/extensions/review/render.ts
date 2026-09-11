import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { DagNodeStatus, type DagNodeStatus as DagNodeStatusValue } from "../../../src/dag/index.js";
import {
  WidthBoundedText,
  renderCompactToolCall,
  renderTextToolResult,
  shortDescription,
  toolResultText,
  type ToolRenderTheme,
  type ToolResultRenderContext,
} from "../_shared/tool-render";
import {
  EvidenceResolverNode,
  ReadingPlanNode,
  ReviewerNodes,
  SynthesisNode,
} from "./review-topology";
import type { PrReviewParams } from "./schema";

interface ReviewUsageDetails {
  readonly cost: number;
  readonly turns?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

interface ReviewRenderDetails {
  readonly status?: string;
  readonly action?: string;
  readonly reviewId?: string;
  readonly runId?: string;
  readonly nodes?: Readonly<Record<string, string>>;
  readonly usage?: ReviewUsageDetails;
  readonly metrics?: { readonly usage?: ReviewUsageDetails };
  readonly verdict?: string;
  readonly reused?: boolean;
}

const ReviewPhaseStatus = {
  Complete: "complete",
  Active: "active",
  Queued: "queued",
  Failed: "failed",
  Blocked: "blocked",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
type ReviewPhaseStatus = (typeof ReviewPhaseStatus)[keyof typeof ReviewPhaseStatus];

export interface ReviewPhaseProgress {
  readonly label: "planning" | "reviewing" | "synthesizing";
  readonly status: ReviewPhaseStatus;
  readonly activeRoles: readonly string[];
  readonly terminalRoles: readonly string[];
}

interface ReviewPhaseDefinition {
  readonly label: ReviewPhaseProgress["label"];
  readonly nodes: readonly { readonly nodeId: string; readonly role: string }[];
}

const ReviewPhases: readonly ReviewPhaseDefinition[] = [
  {
    label: "planning",
    nodes: [
      { nodeId: ReadingPlanNode.nodeId, role: "reading plan" },
      { nodeId: EvidenceResolverNode.nodeId, role: "evidence" },
    ],
  },
  {
    label: "reviewing",
    nodes: ReviewerNodes.map((node) => ({ nodeId: node.nodeId, role: node.role })),
  },
  {
    label: "synthesizing",
    nodes: [{ nodeId: SynthesisNode.nodeId, role: SynthesisNode.role }],
  },
];

function nodeStatus(nodes: Readonly<Record<string, string>>, nodeId: string): DagNodeStatusValue {
  const status = nodes[nodeId];
  return Object.values(DagNodeStatus).includes(status as DagNodeStatusValue)
    ? (status as DagNodeStatusValue)
    : DagNodeStatus.Queued;
}

const TerminalNodeStatuses: readonly DagNodeStatusValue[] = [
  DagNodeStatus.Failed,
  DagNodeStatus.Blocked,
  DagNodeStatus.Cancelled,
  DagNodeStatus.Interrupted,
];

function terminalStatus(statuses: readonly DagNodeStatusValue[]): ReviewPhaseStatus | undefined {
  if (statuses.includes(DagNodeStatus.Failed)) return ReviewPhaseStatus.Failed;
  if (statuses.includes(DagNodeStatus.Interrupted)) return ReviewPhaseStatus.Interrupted;
  if (statuses.includes(DagNodeStatus.Cancelled)) return ReviewPhaseStatus.Cancelled;
  if (statuses.includes(DagNodeStatus.Blocked)) return ReviewPhaseStatus.Blocked;
  return undefined;
}

export function projectReviewProgress(
  nodes: Readonly<Record<string, string>>,
): readonly ReviewPhaseProgress[] {
  return ReviewPhases.map((phase) => {
    const entries = phase.nodes.map((node) => ({
      ...node,
      status: nodeStatus(nodes, node.nodeId),
    }));
    const statuses = entries.map((entry) => entry.status);
    const running = entries
      .filter((entry) => entry.status === DagNodeStatus.Running)
      .map((entry) => entry.role);
    const terminalRoles = entries
      .filter((entry) => TerminalNodeStatuses.includes(entry.status))
      .map((entry) => `${entry.role} ${entry.status}`);
    if (running.length > 0) {
      return {
        label: phase.label,
        status: ReviewPhaseStatus.Active,
        activeRoles: running,
        terminalRoles,
      };
    }
    const terminal = terminalStatus(statuses);
    if (terminal) {
      return {
        label: phase.label,
        status: terminal,
        activeRoles: [],
        terminalRoles,
      };
    }
    if (statuses.every((status) => status === DagNodeStatus.Succeeded)) {
      return {
        label: phase.label,
        status: ReviewPhaseStatus.Complete,
        activeRoles: [],
        terminalRoles: [],
      };
    }
    if (statuses.every((status) => status === DagNodeStatus.Queued)) {
      return {
        label: phase.label,
        status: ReviewPhaseStatus.Queued,
        activeRoles: [],
        terminalRoles: [],
      };
    }
    const pending = entries
      .filter((entry) => entry.status !== DagNodeStatus.Succeeded)
      .map((entry) => entry.role);
    return {
      label: phase.label,
      status: ReviewPhaseStatus.Active,
      activeRoles: pending,
      terminalRoles: [],
    };
  });
}

function phaseText(phase: ReviewPhaseProgress, theme: ToolRenderTheme): string {
  switch (phase.status) {
    case ReviewPhaseStatus.Complete:
      return theme.fg("success", `${phase.label} ✓`);
    case ReviewPhaseStatus.Active: {
      const roles = shortDescription(phase.activeRoles.join(", "));
      const active = theme.fg("warning", `${phase.label}${roles ? ` ${roles}` : ""}`);
      const terminal = phase.terminalRoles.length
        ? ` ${theme.fg("error", `[${phase.terminalRoles.join(", ")}]`)}`
        : "";
      return `${active}${terminal}`;
    }
    case ReviewPhaseStatus.Queued:
      return theme.fg("dim", `${phase.label} ○`);
    case ReviewPhaseStatus.Failed:
      return theme.fg("error", `${phase.label}: ${phase.terminalRoles.join(", ")}`);
    case ReviewPhaseStatus.Blocked:
    case ReviewPhaseStatus.Cancelled:
    case ReviewPhaseStatus.Interrupted:
      return theme.fg("warning", `${phase.label}: ${phase.terminalRoles.join(", ")}`);
  }
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function renderReviewProgress(details: ReviewRenderDetails, theme: ToolRenderTheme): Component {
  const phases = projectReviewProgress(details.nodes ?? {});
  const arrows = theme.fg("muted", " → ");
  const lines = [
    `${theme.fg("warning", "•")} ${theme.fg("toolTitle", "review")}`,
    `  ${phases.map((phase) => phaseText(phase, theme)).join(arrows)}`,
  ];
  if (details.usage && Number.isFinite(details.usage.cost)) {
    lines.push(`  ${theme.fg("muted", `cost: ${formatCost(details.usage.cost)}`)}`);
  }
  if (details.reviewId) lines.push(`  ${theme.fg("dim", details.reviewId)}`);
  return new WidthBoundedText(lines.join("\n"));
}

function terminalPresentation(status: string | undefined, isError: boolean | undefined) {
  if (status === "failed") return { color: "error", icon: "✗" };
  if (["degraded", "cancelled", "interrupted"].includes(status ?? "")) {
    return { color: "warning", icon: "⚠" };
  }
  return isError ? { color: "error", icon: "✗" } : { color: "success", icon: "✓" };
}

function terminalCannotProduceVerdict(status: string | undefined): boolean {
  return ["failed", "cancelled", "interrupted"].includes(status ?? "");
}

function renderReviewTerminal(
  result: AgentToolResult<unknown>,
  details: ReviewRenderDetails,
  options: ToolRenderResultOptions,
  theme: ToolRenderTheme,
  context?: ToolResultRenderContext,
): Component {
  const presentation = terminalPresentation(details.status, context?.isError);
  const header = `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("toolTitle", "review")}`;
  const usage = details.metrics?.usage;
  const verdict = details.verdict;
  const costLabel = details.reused ? "recorded cost" : "cost";
  const metadata = [
    ...(usage && Number.isFinite(usage.cost)
      ? [`  ${theme.fg("muted", `${costLabel}: ${formatCost(usage.cost)}`)}`]
      : []),
    ...(details.reviewId ? [`  ${theme.fg("dim", details.reviewId)}`] : []),
  ];

  if (options.expanded) {
    const fullVerdict =
      verdict ?? (terminalCannotProduceVerdict(details.status) ? "unavailable" : undefined);
    const detailed = toolResultText(result);
    return new Text(
      [
        header,
        ...(fullVerdict ? [`  verdict: ${fullVerdict}`] : []),
        ...metadata,
        ...(detailed ? [theme.fg("muted", "─── details ───"), detailed] : []),
      ].join("\n"),
      0,
      0,
    );
  }

  const compactVerdict = verdict
    ? shortDescription(verdict, { oneLine: true })
    : terminalCannotProduceVerdict(details.status)
      ? "unavailable"
      : undefined;
  return new WidthBoundedText(
    [header, ...(compactVerdict ? [`  verdict: ${compactVerdict}`] : []), ...metadata].join("\n"),
  );
}

export function renderReviewCall(args: PrReviewParams, theme: ToolRenderTheme): Component {
  return renderCompactToolCall(
    "review",
    [args.command, args.action, args.url].filter(Boolean).join(" "),
    theme,
  );
}

export function renderReviewResult(
  result: AgentToolResult<Record<string, unknown>>,
  options: ToolRenderResultOptions,
  theme: ToolRenderTheme,
  context?: ToolResultRenderContext,
): Component {
  const details = (result.details ?? {}) as ReviewRenderDetails;
  if (options.isPartial || details.nodes) return renderReviewProgress(details, theme);
  if (!details.reviewId) return renderTextToolResult("review", result, options, theme, context);
  return renderReviewTerminal(result, details, options, theme, context);
}
