import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  renderCompactToolCall,
  renderTextToolResult,
  type ToolRenderTheme,
  type ToolResultRenderContext,
} from "../_shared/tool-render";
import type { PrReviewParams } from "./schema";

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
  context: ToolResultRenderContext,
): Component {
  return renderTextToolResult("review", result, options, theme, context);
}
