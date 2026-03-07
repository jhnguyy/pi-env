/**
 * Session Reader Extension — entry point.
 *
 * Registers the `read_session` tool, which extracts high-signal content
 * from a pi session JSONL file: user prompts, agent narrative text,
 * tool usage counts, and extension messages. Raw tool outputs are excluded.
 *
 * Inactive by default — not visible to the LLM in normal sessions.
 * Enable by setting PI_SESSION_READER=1 in the environment before launching pi.
 * This is intended for use in dedicated review subagents, not interactive sessions.
 *
 * Usage (spawn a review subagent):
 *   PI_SESSION_READER=1 pi --no-session \
 *     -e ~/.pi/agent/extensions/session-reader/index.ts \
 *     --tools read_session,read,notes,write,edit,bash \
 *     @/tmp/review-brief.md "..."
 *
 * Security: output may contain sensitive content from user prompts and agent
 * reasoning. Do not log or publish raw read_session output to external channels.
 *
 * Branch note: sessions are trees. This tool reads lines in file order and may
 * include content from abandoned branches if the session was forked. All explored
 * paths are included — useful for review since discarded approaches matter too.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { extractSession, formatSummary } from "./extractor";

const SESSION_DIR = resolve(homedir(), ".pi/agent/sessions");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_session",
    label: "Read Session",
    description:
      "Extract high-signal content from a pi session JSONL file. " +
      "Returns user prompts, agent narrative text (no raw tool outputs), " +
      "tool usage counts, and extension messages. " +
      "Use to understand what happened in a past session without parsing raw JSONL. " +
      "Discover session files with: find ~/.pi/agent/sessions/ -name '*.jsonl' | sort -r | head -20",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to a session .jsonl file under ~/.pi/agent/sessions/",
      }),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx: any) {
      // Check cancellation before doing any I/O
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Cancelled." }], details: {} };
      }

      // Strip leading @ (some models include it in path arguments)
      const p = resolve(params.path.replace(/^@/, ""));

      // Restrict to session directory — prevents read_session from being
      // used as a general-purpose JSONL reader on arbitrary files.
      if (!p.startsWith(SESSION_DIR + "/")) {
        throw new Error(
          `read_session is restricted to session files under ${SESSION_DIR}/. Got: ${p}`,
        );
      }

      // extractSession validates extension and existence — errors propagate as tool errors
      const summary = extractSession(p);
      const raw = formatSummary(summary);

      // Truncate to avoid overwhelming the LLM context window
      const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = trunc.content;
      if (trunc.truncated) {
        text +=
          `\n\n[Output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}. ` +
          `Session had ${summary.userMessages.length} user turns and ${summary.agentNarrative.length} narrative blocks.]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          filename: summary.filename,
          timestamp: summary.timestamp,
          toolCounts: summary.toolCounts,
          truncated: trunc.truncated,
        },
      };
    },
  });

  // Deactivate in normal sessions — the tool is registered (discoverable via
  // getAllTools) but not active (not visible to the LLM).
  // Set PI_SESSION_READER=1 to keep it active (for review subagents).
  if (!process.env.PI_SESSION_READER) {
    pi.on("session_start", async () => {
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "read_session"));
    });
  }
}
