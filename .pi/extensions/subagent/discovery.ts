/**
 * discovery.ts — dynamic description builder for the subagent tool.
 *
 * Builds the session_start-time enriched description listing available
 * models (from settings + registry) and discovered agent files.
 */

import type { AgentConfig } from "./agents";
import { BUILT_IN_TOOLS } from "./execute";
import type { ToolCapability } from "./types";
import { formatCapabilities } from "./types";

// ─── Tool listing with capabilities ───────────────────────────────────────────

function formatToolList(
  extToolNames?: string[],
  extToolCaps?: Map<string, ToolCapability[]>,
): string[] {
  const lines: string[] = [];

  // Built-in tools with capabilities
  const builtInParts = Object.entries(BUILT_IN_TOOLS)
    .map(([name, def]) => `${name} (${formatCapabilities(def.capabilities)})`);
  lines.push(`Built-in tools: ${builtInParts.join(", ")}.`);

  // Extension tools (dynamically registered)
  if (extToolNames && extToolNames.length > 0) {
    const extParts = extToolNames.map((name) => {
      const caps = extToolCaps?.get(name) ?? [];
      return caps.length ? `${name} (${formatCapabilities(caps)})` : name;
    });
    lines.push(`Extension tools: ${extParts.join(", ")}.`);
  }

  return lines;
}

// ─── Static description (shown before session_start enrichment) ───────────────

export const STATIC_DESCRIPTION = [
  "Delegate a focused task to an in-process subagent running via agentLoop().",
  "The subagent runs inside the parent tool call — abort propagates automatically,",
  "progress streams live to the TUI. No subprocess overhead.",
  "",
  "Two modes:",
  '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/capabilities/model/prompt from the agent definition',
  '     If the agent file omits model, you MUST pass model explicitly: subagent({ agent: "scout", task: "...", model: "provider/id" })',
  '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
  "",
  ...formatToolList(),
  "Extension tools are available when registered.",
].join("\n");

// ─── Dynamic description builder ──────────────────────────────────────────────

export function buildDynamicDescription(
  enabledModelIds: string[],
  availableModels: Array<{ provider: string; id: string; name: string }>,
  agents: AgentConfig[],
  extToolNames?: string[],
  extToolCaps?: Map<string, ToolCapability[]>,
  modelAnnotations?: Record<string, string[]>,
): string {
  const lines = [
    "Delegate a focused task to an in-process subagent running via agentLoop().",
    "The subagent runs inside the parent tool call — abort propagates automatically,",
    "progress streams live to the TUI. No subprocess overhead.",
    "",
    "Two modes:",
    '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/capabilities/model/prompt from the agent definition',
    '     If the agent file omits model, you MUST pass model explicitly: subagent({ agent: "scout", task: "...", model: "provider/id" })',
    '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
    "",
    ...formatToolList(extToolNames, extToolCaps),
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
      const modelKey = `${m.provider}/${m.id}`;
      const tags = modelAnnotations?.[modelKey];
      const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      lines.push(`  ${modelKey} — ${m.name}${tagSuffix}`);
    }
    lines.push(
      "",
      "Model selection: choose based on task complexity and cost.",
      "  - Models tagged [preferred] are cost-effective — use for gathering, summarization, and mechanical edits.",
      "  - Reserve heavier models for tasks requiring judgment, adversarial thinking, or subtle reasoning.",
      "  - Always pass model explicitly — there is no default.",
    );
  } else {
    lines.push("", "Model: 'provider/model-id' format. Required — no default.");
  }

  if (agents.length > 0) {
    lines.push("", "Available agents:");
    for (const a of agents) {
      const parts = [`${a.name} (${a.source}): ${a.description}`];
      const meta: string[] = [];
      if (a.capabilities?.length) meta.push(`capabilities: ${a.capabilities.join(", ")}`);
      if (a.tools?.length) meta.push(`tools: ${a.tools.join(", ")}`);
      meta.push(a.model ? `model: ${a.model}` : `model: REQUIRED — pass model param`);
      if (meta.length > 0) parts.push(`[${meta.join(" | ")}]`);
      lines.push(`  ${parts.join(" ")}`);
    }
  }

  return lines.join("\n");
}
