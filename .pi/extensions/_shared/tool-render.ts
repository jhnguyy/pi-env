import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  keyHint,
  keyText,
  rawKeyHint,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

export const DEFAULT_SHORT_DESCRIPTION_LIMIT = 70;

export interface ToolRenderTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface ToolResultRenderContext {
  readonly isError: boolean;
}

export interface ShortDescriptionOptions {
  readonly limit?: number;
  readonly oneLine?: boolean;
}

/** Create a compact description without changing the source used by expanded views. */
export function shortDescription(source: string, options: ShortDescriptionOptions = {}): string {
  const limit = options.limit ?? DEFAULT_SHORT_DESCRIPTION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("The short-description limit must be a non-negative safe integer.");
  }
  const plain = stripTerminalSequences(source);
  const text = options.oneLine ? plain.replace(/\s+/gu, " ").trim() : plain;
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join("")}...` : text;
}

/** A compact text component that truncates ANSI text at the current viewport width. */
export class WidthBoundedText implements Component {
  constructor(readonly text: string) {}

  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export function toolExpandKeyHint(description = "to expand"): string {
  return keyText("app.tools.expand")
    ? keyHint("app.tools.expand", description)
    : rawKeyHint("ctrl+o", description);
}

export function toolExpandHint(theme: ToolRenderTheme, description = "to expand"): string {
  return `${theme.fg("muted", "(")}${toolExpandKeyHint(description)}${theme.fg("muted", ")")}`;
}

export type PublicPiToolDefinition<
  Schema extends TSchema = TSchema,
  Details = unknown,
  State = any,
> = ToolDefinition<Schema, Details, State> &
  Required<Pick<ToolDefinition<Schema, Details, State>, "renderCall" | "renderResult">>;

export interface PublicPiToolHost {
  registerTool(tool: any): void;
}

/** Preserve schema inference while requiring the complete public Pi rendering contract. */
export function definePublicTool<Schema extends TSchema, Details = unknown, State = any>(
  tool: PublicPiToolDefinition<Schema, Details, State>,
): PublicPiToolDefinition<Schema, Details, State> {
  return tool;
}

/** Register a model-facing Pi tool only when it owns compact and expanded rendering. */
export function registerPublicTool<Schema extends TSchema, Details = unknown, State = any>(
  pi: PublicPiToolHost,
  tool: PublicPiToolDefinition<Schema, Details, State>,
): PublicPiToolDefinition<Schema, Details, State> {
  pi.registerTool(tool);
  return tool;
}

export function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function bold(theme: ToolRenderTheme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

export function renderCompactToolCall(
  name: string,
  summary: string | undefined,
  theme: ToolRenderTheme,
): Component {
  const header = theme.fg("toolTitle", bold(theme, name));
  const compact = summary ? shortDescription(summary, { oneLine: true }) : "";
  return new WidthBoundedText(compact ? `${header} ${theme.fg("muted", compact)}` : header);
}

/** Default text-result renderer for public tools without a domain-specific result view. */
export function renderTextToolResult(
  name: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: ToolRenderTheme,
  context?: ToolResultRenderContext,
): Component {
  const text = toolResultText(result);
  const failed = context?.isError === true;
  const icon = theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
  const header = `${icon} ${theme.fg("toolTitle", bold(theme, name))}`;
  if (options.expanded) {
    return new Text(`${header}${text ? `\n${text}` : ""}`, 0, 0);
  }
  const summary = shortDescription(text || (failed ? "error" : "complete"), { oneLine: true });
  return new WidthBoundedText(
    `${header}\n  ${theme.fg(failed ? "error" : "toolOutput", summary)}\n${toolExpandHint(theme)}`,
  );
}
