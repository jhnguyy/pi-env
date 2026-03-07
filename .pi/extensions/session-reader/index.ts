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
 *     --tools read_session,read,notes,write,edit \
 *     @/tmp/review-brief.md "..."
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve } from "node:path";

import { extractSession, formatSummary } from "./extractor";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_session",
    label: "Read Session",
    description:
      "Extract high-signal content from a pi session JSONL file. " +
      "Returns user prompts, agent narrative text (no raw tool outputs), " +
      "tool usage counts, and extension messages. " +
      "Use to understand what happened in a past session without parsing raw JSONL. " +
      "Session files are at ~/.pi/agent/sessions/--home-agent--/*.jsonl",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to a session .jsonl file",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      // Strip leading @ (some models include it in path arguments)
      const p = resolve(params.path.replace(/^@/, ""));

      // extractSession validates extension and existence — errors propagate as tool errors
      const summary = extractSession(p);
      const text = formatSummary(summary);

      return {
        content: [{ type: "text" as const, text }],
        details: {
          filename: summary.filename,
          timestamp: summary.timestamp,
          toolCounts: summary.toolCounts,
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
