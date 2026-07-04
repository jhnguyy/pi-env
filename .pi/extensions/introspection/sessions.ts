/**
 * Introspection session navigation helpers.
 *
 * The goal is context economy: expose enough structure to choose which session
 * to inspect, without replaying raw JSONL, tool outputs, or full assistant text.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parseSessionMilestoneLabel } from "../_shared/session-milestones";

export const DEFAULT_SESSION_DIR = resolve(homedir(), ".pi/agent/sessions");

export enum SessionEntryType {
  Session = "session",
  SessionInfo = "session_info",
  Label = "label",
  Compaction = "compaction",
  Message = "message",
  BranchSummary = "branch_summary",
}

export enum MessageRole {
  User = "user",
  Assistant = "assistant",
  ToolResult = "toolResult",
}

export enum ContentBlockType {
  Text = "text",
}

export interface SessionDigest {
  file: string;
  sessionId?: string;
  cwd?: string;
  timestamp: string;
  name?: string;
  firstUserPrompt?: string;
  lastUserPrompt?: string;
  userTurns: number;
  assistantTurns: number;
  toolResults: number;
  toolErrors: number;
  toolCounts: Record<string, number>;
  labels: Array<{ targetId: string; label: string }>;
  compacted: boolean;
  branches: number;
  bytes: number;
}

export interface SessionView extends SessionDigest {
  userPrompts: Array<{ line: number; text: string }>;
  toolErrorSummaries: Array<{ line: number; toolName: string; text: string }>;
  branchSummaries: Array<{ line: number; text: string }>;
  compactions: Array<{ line: number; tokensBefore?: number; text: string }>;
}

interface TextBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  targetId?: string;
  label?: string;
  name?: string;
  cwd?: string;
  id_?: string;
  sessionId?: string;
  summary?: string;
  tokensBefore?: number;
  message?: {
    role?: string;
    toolName?: string;
    isError?: boolean;
    content?: string | TextBlock[];
  };
}

export function parseTimestamp(filename: string): string {
  const base = filename.replace(/\.jsonl$/, "").split("_")[0];
  return base.replace(/T(\d{2})-(\d{2})-(\d{2})-\d+Z$/, "T$1:$2:$3Z");
}

export function textFromContent(content: string | TextBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .filter((block) => block.type === ContentBlockType.Text && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n")
    .trim();
}

export function oneLine(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function parseLine(line: string): SessionEntry | undefined {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return undefined;
  }
}

export function digestLines(lines: string[], file: string, bytes = 0): SessionDigest {
  const filename = basename(file);
  const timestamp = parseTimestamp(filename);
  const toolCounts: Record<string, number> = {};
  const labels: Array<{ targetId: string; label: string }> = [];
  const childCounts = new Map<string | null, number>();

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let name: string | undefined;
  let firstUserPrompt: string | undefined;
  let lastUserPrompt: string | undefined;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let compacted = false;

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;

    if (entry.id && entry.parentId !== undefined) {
      childCounts.set(entry.parentId ?? null, (childCounts.get(entry.parentId ?? null) ?? 0) + 1);
    }

    switch (entry.type) {
      case SessionEntryType.Session:
        sessionId = entry.id;
        cwd = entry.cwd;
        break;

      case SessionEntryType.SessionInfo:
        name = entry.name;
        break;

      case SessionEntryType.Label:
        if (entry.targetId && entry.label) labels.push({ targetId: entry.targetId, label: entry.label });
        break;

      case SessionEntryType.Compaction:
        compacted = true;
        break;

      case SessionEntryType.Message: {
        const message = entry.message;
        if (!message) break;

        switch (message.role) {
          case MessageRole.User: {
            userTurns += 1;
            const text = oneLine(textFromContent(message.content));
            if (text) {
              firstUserPrompt ??= text;
              lastUserPrompt = text;
            }
            break;
          }

          case MessageRole.Assistant:
            assistantTurns += 1;
            break;

          case MessageRole.ToolResult: {
            toolResults += 1;
            const tool = message.toolName ?? "unknown";
            toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
            if (message.isError) toolErrors += 1;
            break;
          }
        }
        break;
      }
    }
  }

  let branches = 0;
  for (const count of childCounts.values()) {
    if (count > 1) branches += count - 1;
  }

  return {
    file,
    sessionId,
    cwd,
    timestamp,
    name,
    firstUserPrompt,
    lastUserPrompt,
    userTurns,
    assistantTurns,
    toolResults,
    toolErrors,
    toolCounts,
    labels,
    compacted,
    branches,
    bytes,
  };
}

export function inspectLines(lines: string[], file: string, bytes = 0): SessionView {
  const digest = digestLines(lines, file, bytes);
  const userPrompts: SessionView["userPrompts"] = [];
  const toolErrorSummaries: SessionView["toolErrorSummaries"] = [];
  const branchSummaries: SessionView["branchSummaries"] = [];
  const compactions: SessionView["compactions"] = [];

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const entry = parseLine(line);
    if (!entry) return;

    switch (entry.type) {
      case SessionEntryType.BranchSummary:
        if (entry.summary) branchSummaries.push({ line: lineNo, text: oneLine(entry.summary, 300) });
        return;

      case SessionEntryType.Compaction:
        compactions.push({ line: lineNo, tokensBefore: entry.tokensBefore, text: oneLine(entry.summary ?? "", 300) });
        return;

      case SessionEntryType.Message: {
        const message = entry.message;
        if (!message) return;

        switch (message.role) {
          case MessageRole.User: {
            const text = oneLine(textFromContent(message.content), 500);
            if (text) userPrompts.push({ line: lineNo, text });
            return;
          }

          case MessageRole.ToolResult: {
            if (!message.isError) return;
            const text = oneLine(textFromContent(message.content), 260);
            toolErrorSummaries.push({ line: lineNo, toolName: message.toolName ?? "unknown", text });
            return;
          }

          case MessageRole.Assistant:
            return;
        }
      }
    }
  });

  return { ...digest, userPrompts, toolErrorSummaries, branchSummaries, compactions };
}

export function readSessionFile(path: string): { lines: string[]; bytes: number } {
  const file = resolve(path.replace(/^@/, ""));
  if (!file.endsWith(".jsonl")) throw new Error(`Expected a .jsonl file, got: ${file}`);
  if (!existsSync(file)) throw new Error(`Session file not found: ${file}`);
  const raw = readFileSync(file, "utf8");
  return { lines: raw.trim().split("\n").filter(Boolean), bytes: Buffer.byteLength(raw) };
}

export function assertUnderSessionDir(path: string, sessionDir = DEFAULT_SESSION_DIR): string {
  const file = resolve(path.replace(/^@/, ""));
  const root = resolve(sessionDir);
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Session access is restricted to ${root}/. Got: ${file}`);
  }
  return file;
}

export function listSessionFiles(sessionDir = DEFAULT_SESSION_DIR): string[] {
  const root = resolve(sessionDir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function listSessionDigests(options: {
  sessionDir?: string;
  cwd?: string;
  query?: string;
  limit?: number;
} = {}): SessionDigest[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const query = options.query?.toLowerCase().trim();
  const cwd = options.cwd ? resolve(options.cwd) : undefined;
  const results: SessionDigest[] = [];

  for (const file of listSessionFiles(options.sessionDir)) {
    const { lines, bytes } = readSessionFile(file);
    const digest = digestLines(lines, file, bytes);
    if (cwd && resolve(digest.cwd ?? dirname(file)) !== cwd) continue;
    if (query) {
      const haystack = [digest.cwd, digest.name, digest.firstUserPrompt, digest.lastUserPrompt, digest.timestamp]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    results.push(digest);
    if (results.length >= limit) break;
  }

  return results;
}


class MarkdownBuilder {
  private readonly lines: string[] = [];

  line(text = ""): this {
    this.lines.push(text);
    return this;
  }

  linesOf(lines: string[]): this {
    this.lines.push(...lines);
    return this;
  }

  section(title: string, lines: string[]): this {
    if (lines.length === 0) return this;
    if (this.lines.length > 0) this.line();
    return this.line(`### ${title}`).linesOf(lines);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

function formatToolCounts(toolCounts: Record<string, number>): string | undefined {
  const text = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name}(${count})`)
    .join(", ");
  return text || undefined;
}

function splitLabels(labels: SessionDigest["labels"]): {
  milestones: Array<{ targetId: string; text: string }>;
  labels: SessionDigest["labels"];
} {
  const milestones: Array<{ targetId: string; text: string }> = [];
  const plainLabels: SessionDigest["labels"] = [];

  for (const label of labels) {
    const milestone = parseSessionMilestoneLabel(label.label);
    if (milestone) milestones.push({ targetId: label.targetId, text: milestone.text });
    else plainLabels.push(label);
  }

  return { milestones, labels: plainLabels };
}

function formatDigest(s: SessionDigest, index: number): string {
  const title = s.name ? `${s.name} — ${s.timestamp}` : s.timestamp;
  const counts = `${s.userTurns} user, ${s.assistantTurns} assistant, ${s.toolResults} tools, ${s.toolErrors} tool errors`;
  const { milestones, labels } = splitLabels(s.labels);
  const markers = [
    s.compacted ? "compacted" : undefined,
    s.branches ? `${s.branches} branch(es)` : undefined,
    milestones.length ? `${milestones.length} milestone(s)` : undefined,
    labels.length ? `${labels.length} label(s)` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return new MarkdownBuilder()
    .line(`${index + 1}. ${title}`)
    .line(`   ${s.cwd ? `cwd: ${s.cwd}` : "cwd: unknown"}`)
    .line(`   ${counts}${markers ? `; ${markers}` : ""}`)
    .line(`   ${s.firstUserPrompt ? `first: ${s.firstUserPrompt}` : "first: (none)"}`)
    .line(`   file: ${s.file}`)
    .toString();
}

export function formatDigestList(sessions: SessionDigest[]): string {
  if (sessions.length === 0) return "No matching pi sessions found.";
  return sessions.map(formatDigest).join("\n\n");
}

export function formatSessionView(view: SessionView): string {
  const { milestones, labels } = splitLabels(view.labels);
  const builder = new MarkdownBuilder()
    .line(`## Session ${view.name ? `${view.name} — ` : ""}${view.timestamp}`)
    .linesOf([
      view.cwd ? `cwd: ${view.cwd}` : undefined,
      `file: ${view.file}`,
      `turns: ${view.userTurns} user, ${view.assistantTurns} assistant, ${view.toolResults} tool results, ${view.toolErrors} tool errors`,
      formatToolCounts(view.toolCounts) ? `tools: ${formatToolCounts(view.toolCounts)}` : undefined,
      view.branches ? `branches: ${view.branches}` : undefined,
      view.compacted ? "compacted: yes" : undefined,
    ].filter((line): line is string => Boolean(line)));

  return builder
    .section("Milestones", milestones.map((milestone) => `- ${milestone.text} → ${milestone.targetId}`))
    .section("Labels", labels.map((label) => `- ${label.label} → ${label.targetId}`))
    .section("User prompts", view.userPrompts.map((prompt, i) => `${i + 1}. L${prompt.line}: ${prompt.text}`))
    .section("Tool errors", view.toolErrorSummaries.map((error) => `- L${error.line} ${error.toolName}: ${error.text}`))
    .section("Branch summaries", view.branchSummaries.map((branch) => `- L${branch.line}: ${branch.text}`))
    .section("Compactions", view.compactions.map((compaction) => `- L${compaction.line}${compaction.tokensBefore ? ` (${compaction.tokensBefore} tokens)` : ""}: ${compaction.text}`))
    .toString();
}
