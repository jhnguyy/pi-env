/**
 * render.ts — TUI rendering for the subagent tool.
 *
 * renderSubagentCall  — collapsed call view (args preview).
 * renderSubagentResult — collapsed + expanded result view (output, stats, usage).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import {
  SubagentJobStatus,
  type SubagentDetails,
  type SubagentJobRenderDetails,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expandKeyText(): string {
  return keyText("app.tools.expand") || "ctrl+o";
}

const PROMPT_PREVIEW_LENGTH = 70;

function formatPromptPreview(task: string): string {
  return task.length > PROMPT_PREVIEW_LENGTH ? `${task.slice(0, PROMPT_PREVIEW_LENGTH)}...` : task;
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageStats(usage: SubagentDetails["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns !== 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// ─── renderCall ───────────────────────────────────────────────────────────────

export function renderSubagentCall(
  args: { name?: string; agent?: string; task?: string; tools?: string[]; model?: string },
  theme: any,
  _ctx?: unknown,
) {
  const preview = formatPromptPreview(args.task ?? "");
  const nameStr = args.name ? `${theme.fg("accent", args.name)} ` : "";
  const agentStr = args.agent ? theme.fg("accent", args.agent as string) + " " : "";
  const tools = args.tools as string[] | undefined;
  const toolsStr = tools ? `[${tools.join(", ")}]` : "";
  const modelStr = args.model ? ` (${args.model})` : "";
  const text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    nameStr +
    agentStr +
    theme.fg("dim", `${toolsStr}${modelStr}`) +
    "\n  " +
    theme.fg("toolOutput", preview);
  return new Text(text, 0, 0);
}

// ─── renderResult ──────────────────────────────────────────────────────────────

function subagentResultIcon(details: SubagentDetails, theme: any): string {
  if (details.isError) return theme.fg("error", "✗");
  if (details.turnLimitExceeded) return theme.fg("warning", "⚠");
  return theme.fg("success", "✓");
}

function toolCallSummary(details: SubagentDetails): string {
  if (details.toolCallCount <= 0) return "";
  return `${details.toolCallCount} tool call${details.toolCallCount !== 1 ? "s" : ""}`;
}

function expandedSubagentHeader(details: SubagentDetails, icon: string, theme: any): string {
  let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
  if (details.agent) header += ` ${theme.fg("accent", details.agent)}`;
  if (details.isError && details.stopReason) {
    header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
  }
  if (details.turnLimitExceeded) {
    header += ` ${theme.fg("warning", `[turn limit: ${details.maxTurns ?? "configured"}]`)}`;
  }
  return header;
}

function expandedSubagentStats(details: SubagentDetails, tools: string): string[] {
  const parts: string[] = [];
  if (tools) parts.push(tools);
  if (details.modelOverride) parts.push(`model: ${details.modelOverride}`);
  if (details.sessionName) parts.push(`session: ${details.sessionName}`);
  if (details.sessionFile) parts.push(details.sessionFile);
  return parts;
}

function appendExpandedSubagentOutput(
  container: Container,
  details: SubagentDetails,
  theme: any,
): void {
  container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
  if (details.isError && details.errorMessage) {
    container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
    return;
  }
  if (!details.finalOutput || details.finalOutput === "(no output)") {
    container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    return;
  }
  container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, getMarkdownTheme()));
}

function renderExpandedSubagentResult(
  details: SubagentDetails,
  icon: string,
  usage: string,
  tools: string,
  theme: any,
): Container {
  const container = new Container();
  container.addChild(new Text(expandedSubagentHeader(details, icon, theme), 0, 0));

  const statParts = expandedSubagentStats(details, tools);
  if (statParts.length > 0) {
    container.addChild(new Text(theme.fg("muted", statParts.join(" · ")), 0, 0));
  }

  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
  container.addChild(new Spacer(1));
  appendExpandedSubagentOutput(container, details, theme);

  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  return container;
}

function renderCollapsedSubagentResult(
  details: SubagentDetails,
  icon: string,
  usage: string,
  tools: string,
  theme: any,
): Text {
  // The call renderer already shows the truncated task; full output belongs in the expanded view.
  let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
  if (details.agent) text += ` ${theme.fg("accent", details.agent)}`;
  if (details.isError) {
    const message = details.errorMessage || details.stopReason || "error";
    text += ` ${theme.fg("error", `[${message}]`)}`;
  }
  if (details.turnLimitExceeded) text += ` ${theme.fg("warning", "[turn limit]")}`;

  const stats: string[] = [];
  if (tools) stats.push(tools);
  if (usage) stats.push(usage);
  if (details.sessionName) stats.push(details.sessionName);
  if (stats.length > 0) text += `\n${theme.fg("dim", stats.join(" · "))}`;
  text += `\n${theme.fg("muted", `(${expandKeyText()} to expand)`)}`;
  return new Text(text, 0, 0);
}

export function renderSubagentResult(
  result: AgentToolResult<SubagentDetails>,
  { expanded }: { expanded: boolean },
  theme: any,
  _ctx?: unknown,
) {
  const details = result.details as SubagentDetails | undefined;
  if (!details) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const icon = subagentResultIcon(details, theme);
  const usage = formatUsageStats(details.usage, details.model);
  const tools = toolCallSummary(details);
  return expanded
    ? renderExpandedSubagentResult(details, icon, usage, tools, theme)
    : renderCollapsedSubagentResult(details, icon, usage, tools, theme);
}

interface ToolRenderContext {
  args?: Record<string, unknown>;
}

function jobStatusIcon(status: SubagentJobRenderDetails["status"], theme: any): string {
  switch (status) {
    case SubagentJobStatus.Completed:
      return theme.fg("success", "✓");
    case SubagentJobStatus.Failed:
      return theme.fg("error", "✗");
    case SubagentJobStatus.Cancelled:
      return theme.fg("warning", "⚠");
    default:
      return theme.fg("accent", "•");
  }
}

function appendJobStats(parts: string[], details: SubagentJobRenderDetails): void {
  if (details.toolCallCount) {
    parts.push(`${details.toolCallCount} tool call${details.toolCallCount === 1 ? "" : "s"}`);
  }
  if (details.usage) {
    const usage = formatUsageStats(details.usage, details.model);
    if (usage) parts.push(usage);
  }
  if (details.sessionName) parts.push(details.sessionName);
}

/** Render the non-blocking start acknowledgement without exposing raw arguments. */
export function renderSubagentStartResult(
  result: AgentToolResult<SubagentJobRenderDetails>,
  { expanded }: { expanded: boolean },
  theme: any,
  context?: ToolRenderContext,
) {
  const details = result.details;
  const status = details?.status;
  const jobId = details?.jobId;
  const header =
    `${jobStatusIcon(status, theme)} ${theme.fg("toolTitle", theme.bold("subagent start"))}` +
    (details?.name ? ` ${theme.fg("accent", details.name)}` : "") +
    (status ? ` ${theme.fg("muted", `[${status}]`)}` : "") +
    (jobId ? ` ${theme.fg("dim", jobId)}` : "");

  if (!expanded) {
    return new Text(`${header}\n${theme.fg("muted", `(${expandKeyText()} to expand)`)}`, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  const task = typeof context?.args?.task === "string" ? context.args.task : (details?.task ?? "");
  if (task) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", task), 0, 0));
  }
  const output = textContent(result);
  if (output) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Status ───"), 0, 0));
    container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
  }
  return container;
}

export function renderSubagentJobCall(args: { action?: string; job_id?: string }, theme: any) {
  const action = args.action ?? "inspect";
  const jobId = args.job_id ? ` ${theme.fg("dim", args.job_id)}` : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("subagent job"))} ${theme.fg("accent", action)}${jobId}`,
    0,
    0,
  );
}

/** Render async job inspection compactly while preserving full content on expansion. */
export function renderSubagentJobResult(
  result: AgentToolResult<SubagentJobRenderDetails>,
  { expanded }: { expanded: boolean },
  theme: any,
) {
  const details = result.details ?? {};
  const status = details.status;
  let header = `${jobStatusIcon(status, theme)} ${theme.fg("toolTitle", theme.bold("subagent job"))}`;
  if (details.name) header += ` ${theme.fg("accent", details.name)}`;
  if (status) header += ` ${theme.fg("muted", `[${status}]`)}`;
  if (details.jobId) header += ` ${theme.fg("dim", details.jobId)}`;
  if (details.count !== undefined) header += ` ${theme.fg("dim", `${details.count} jobs`)}`;

  const statParts: string[] = [];
  appendJobStats(statParts, details);
  const output = textContent(result);

  if (!expanded) {
    let text = header;
    if (details.task) text += `\n${theme.fg("toolOutput", formatPromptPreview(details.task))}`;
    if (statParts.length > 0) text += `\n${theme.fg("dim", statParts.join(" · "))}`;
    text += `\n${theme.fg("muted", `(${expandKeyText()} to expand)`)}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  if (statParts.length > 0) {
    container.addChild(new Text(theme.fg("muted", statParts.join(" · ")), 0, 0));
  }
  if (details.task) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
  }
  if (output) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
  }
  return container;
}
