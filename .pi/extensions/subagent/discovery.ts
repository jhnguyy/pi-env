/**
 * discovery.ts — dynamic description builder for the subagent tool.
 *
 * Builds the session_start-time enriched description listing available
 * models (from settings + registry) and discovered agent files.
 */

import type { AgentConfig } from "./agents";

// ─── Static description (shown before session_start enrichment) ───────────────

export const STATIC_DESCRIPTION = [
  "Delegate a focused task to an in-process subagent running via agentLoop().",
  "The subagent runs inside the parent tool call — abort propagates automatically,",
  "progress streams live to the TUI. No subprocess overhead.",
  "",
  "Two modes:",
  '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/model/prompt from the agent definition',
  '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
  "",
  "Available built-in tools: read, bash, edit, write, grep, find, ls.",
  "Extension tools (dev-tools, notes, etc.) are available when registered.",
  "Model: 'provider/model-id' format. Required — no default.",
].join("\n");

// ─── Dynamic description builder ──────────────────────────────────────────────

export function buildDynamicDescription(
  enabledModelIds: string[],
  availableModels: Array<{ provider: string; id: string; name: string }>,
  agents: AgentConfig[],
): string {
  const lines = [
    "Delegate a focused task to an in-process subagent running via agentLoop().",
    "The subagent runs inside the parent tool call — abort propagates automatically,",
    "progress streams live to the TUI. No subprocess overhead.",
    "",
    "Two modes:",
    '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/model/prompt from the agent definition',
    '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
    "",
    "Available built-in tools: read, bash, edit, write, grep, find, ls.",
    "Extension tools (dev-tools, notes, etc.) are available when registered.",
  ];

  // Intersect enabled list with models that have working auth
  const enabledSet = new Set(enabledModelIds);
  const listedModels =
    enabledSet.size > 0
      ? availableModels.filter((m) => enabledSet.has(`${m.provider}/${m.id}`))
      : availableModels;

  if (listedModels.length > 0) {
    lines.push("", "Available models (use 'provider/model-id' format):");
    for (const m of listedModels) {
      lines.push(`  ${m.provider}/${m.id} — ${m.name}`);
    }
  } else {
    lines.push("", "Model: 'provider/model-id' format. Required — no default.");
  }

  if (agents.length > 0) {
    lines.push("", "Available agents:");
    for (const a of agents) {
      lines.push(`  ${a.name} (${a.source}): ${a.description}`);
    }
  }

  return lines.join("\n");
}
