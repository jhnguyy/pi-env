/**
 * render.ts — TUI rendering for the subagent tool.
 *
 * renderSubagentCall  — collapsed call view (args preview).
 * renderSubagentResult — collapsed + expanded result view (output, stats, usage).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

import { MAX_TURNS, type SubagentDetails } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: SubagentDetails["usage"],
  model?: string,
): string {
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
  args: { agent?: string; task?: string; tools?: string[]; model?: string },
  theme: any,
  _ctx?: unknown,
) {
  const task = args.task ?? "";
  const preview = task.length > 70 ? `${task.slice(0, 70)}...` : task;
  const agentStr = args.agent
    ? theme.fg("accent", args.agent as string) + " "
    : "";
  const tools = args.tools as string[] | undefined;
  const toolsStr = tools ? `[${tools.join(", ")}]` : "";
  const modelStr = args.model ? ` (${args.model})` : "";
  const text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    agentStr +
    theme.fg("dim", `${toolsStr}${modelStr}`) +
    "\n  " +
    theme.fg("toolOutput", preview);
  return new Text(text, 0, 0);
}

// ─── renderResult ──────────────────────────────────────────────────────────────

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

  const icon = details.isError
    ? theme.fg("error", "✗")
    : details.turnLimitExceeded
      ? theme.fg("warning", "⚠")
      : theme.fg("success", "✓");

  const usageStr = formatUsageStats(details.usage, details.model);
  const toolsStr =
    details.toolCallCount > 0
      ? `${details.toolCallCount} tool call${details.toolCallCount !== 1 ? "s" : ""}`
      : "";

  if (expanded) {
    const mdTheme = getMarkdownTheme();
    const container = new Container();

    // Header
    let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
    if (details.agent) {
      header += ` ${theme.fg("accent", details.agent)}`;
    }
    if (details.isError && details.stopReason) {
      header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
    }
    if (details.turnLimitExceeded) {
      header += ` ${theme.fg("warning", `[turn limit: ${MAX_TURNS}]`)}`;
    }
    container.addChild(new Text(header, 0, 0));

    // Stats line
    const statParts: string[] = [];
    if (toolsStr) statParts.push(toolsStr);
    if (details.modelOverride) statParts.push(`model: ${details.modelOverride}`);
    if (statParts.length > 0) {
      container.addChild(new Text(theme.fg("muted", statParts.join(" · ")), 0, 0));
    }

    container.addChild(new Spacer(1));

    // Task
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
    container.addChild(new Spacer(1));

    // Output
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (details.isError && details.errorMessage) {
      container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
    } else if (!details.finalOutput || details.finalOutput === "(no output)") {
      container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    } else {
      container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, mdTheme));
    }

    // Usage
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }

    return container;
  }

  // Collapsed view
  // Note: task preview is omitted here — renderSubagentCall already shows it above.
  let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
  if (details.agent) {
    text += ` ${theme.fg("accent", details.agent)}`;
  }
  if (details.isError) {
    const msg = details.errorMessage || details.stopReason || "error";
    text += ` ${theme.fg("error", `[${msg}]`)}`;
  }
  if (details.turnLimitExceeded) {
    text += ` ${theme.fg("warning", "[turn limit]")}`;
  }

  // Output preview (first 3 lines)
  if (details.finalOutput && details.finalOutput !== "(no output)") {
    const lines = details.finalOutput.split("\n").slice(0, 3).join("\n");
    text += `\n${theme.fg("toolOutput", lines)}`;
  }

  // Stats
  const statsLine: string[] = [];
  if (toolsStr) statsLine.push(toolsStr);
  if (usageStr) statsLine.push(usageStr);
  if (statsLine.length > 0) {
    text += `\n${theme.fg("dim", statsLine.join(" · "))}`;
  }

  text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}
