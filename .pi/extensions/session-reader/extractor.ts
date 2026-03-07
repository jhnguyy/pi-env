/**
 * Session extractor — pure logic, no pi dependencies.
 *
 * Reads a pi session JSONL file and extracts high-signal content:
 *   - User messages (the prompts and directives)
 *   - Agent narrative text (assistant text blocks only — no tool call content)
 *   - Tool usage counts (which tools were called, how often)
 *   - Custom extension messages (work-tracker, session-todos, etc.)
 *
 * Intentionally excludes:
 *   - Raw tool result content (bash output, file reads, etc.) — too noisy
 *   - Tool_use blocks from assistant messages — represented in tool counts
 *   - Metadata entries (session, thinking_level_change, etc.)
 *   - The `custom` type (internal pi entries without user-readable content)
 *
 * Branch note: pi sessions are trees. This extractor reads lines in file order,
 * which may interleave entries from abandoned branches if the session was forked.
 * For review purposes this is acceptable — all explored paths are relevant.
 * Future improvement: accept a leaf entryId and walk parentId chains.
 *
 * Security note: output may contain sensitive content from user prompts and agent
 * reasoning (e.g., API keys typed into prompts, secrets echoed in reasoning).
 * Review subagents should not log or publish raw read_session output.
 */

import { existsSync, readFileSync } from "node:fs";

export interface SessionSummary {
  filename: string;
  timestamp: string;
  userMessages: string[];
  agentNarrative: string[];
  toolCounts: Record<string, number>;
  customMessages: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface MessagePayload {
  role: string;
  toolName?: string;
  content?: ContentBlock[];
}

interface JournalEntry {
  type: string;
  customType?: string;
  content?: unknown; // may be string or array depending on extension
  message?: MessagePayload;
}

/**
 * Parse raw JSONL lines into a SessionSummary.
 * Accepts filename and timestamp separately so this function
 * is pure and testable without file I/O.
 */
export function parseLines(
  lines: string[],
  filename: string,
  timestamp: string,
): SessionSummary {
  const userMessages: string[] = [];
  const agentNarrative: string[] = [];
  const toolCounts: Record<string, number> = {};
  const customMessages: string[] = [];

  for (const line of lines) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "message" && entry.message) {
      const { role, toolName, content } = entry.message;

      if (role === "user") {
        // Collect ALL text blocks in a user turn (not just the first)
        const texts = (content ?? [])
          .filter((c) => c.type === "text" && c.text?.trim())
          .map((c) => c.text!.trim());
        if (texts.length > 0) userMessages.push(texts.join("\n"));
      }

      if (role === "assistant") {
        // Extract only text blocks — skip tool_use blocks
        for (const block of content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            agentNarrative.push(block.text.trim());
          }
        }
      }

      if (role === "toolResult") {
        // Count by tool name; use "unknown" if toolName is absent
        const tool = toolName ?? "unknown";
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      }
    }

    // custom_message entries carry extension-injected context (work-tracker status,
    // session-todos list, etc.) — useful signal for understanding session state.
    // content may be a string or an array depending on the extension.
    if (entry.type === "custom_message" && entry.content != null) {
      const raw = entry.content;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      customMessages.push(`[${entry.customType ?? "custom"}] ${text}`);
    }
  }

  return { filename, timestamp, userMessages, agentNarrative, toolCounts, customMessages };
}

/**
 * Parse a filename like "2026-03-06T23-15-17-780Z_uuid.jsonl"
 * into a readable ISO-8601 timestamp "2026-03-06T23:15:17Z".
 * Returns the raw base string unchanged if the format doesn't match.
 */
export function parseTimestamp(filename: string): string {
  const base = filename.replace(/\.jsonl$/, "").split("_")[0];
  return base.replace(/T(\d{2})-(\d{2})-(\d{2})-\d+Z$/, "T$1:$2:$3Z");
}

/**
 * Extract high-signal content from a session JSONL file.
 */
export function extractSession(filePath: string): SessionSummary {
  if (!filePath.endsWith(".jsonl")) {
    throw new Error(`Expected a .jsonl file, got: ${filePath}`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const filename = filePath.split("/").pop() ?? filePath;
  const timestamp = parseTimestamp(filename);
  return parseLines(lines, filename, timestamp);
}

/**
 * Format a SessionSummary as readable markdown.
 */
export function formatSummary(s: SessionSummary): string {
  const toolStr = Object.entries(s.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}(${v})`)
    .join(", ");

  const parts: string[] = [`## Session: ${s.timestamp}`];
  if (toolStr) parts.push(`**Tools:** ${toolStr}`);
  parts.push("");

  if (s.userMessages.length) {
    parts.push("### User prompts");
    s.userMessages.forEach((m, i) => parts.push(`${i + 1}. ${m}`));
    parts.push("");
  }

  if (s.agentNarrative.length) {
    parts.push("### Agent narrative");
    s.agentNarrative.forEach((n) => parts.push(n));
    parts.push("");
  }

  if (s.customMessages.length) {
    parts.push("### Extension messages");
    s.customMessages.forEach((m) => parts.push(`- ${m}`));
    parts.push("");
  }

  return parts.join("\n");
}
