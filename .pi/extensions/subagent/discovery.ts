import type { AgentConfig } from "./agents";
import { BUILT_IN_TOOLS } from "./resolver";
import { formatCapabilities, type ToolCapability } from "./types";

type AvailableModel = { provider: string; id: string; name: string };

function formatToolList(
  extensionToolNames?: string[],
  extensionToolCapabilities?: Map<string, ToolCapability[]>,
): string[] {
  const lines: string[] = [];
  const builtInTools = Object.entries(BUILT_IN_TOOLS).map(
    ([name, definition]) => `${name} (${formatCapabilities(definition.capabilities)})`,
  );
  lines.push(`Built-in tools: ${builtInTools.join(", ")}.`);

  if (extensionToolNames && extensionToolNames.length > 0) {
    const extensionTools = extensionToolNames.map((name) => {
      const capabilities = extensionToolCapabilities?.get(name) ?? [];
      return capabilities.length ? `${name} (${formatCapabilities(capabilities)})` : name;
    });
    lines.push(`Extension tools: ${extensionTools.join(", ")}.`);
  }

  return lines;
}

const DESCRIPTION_INTRO = [
  "Delegate a focused task to an in-process subagent running via agentLoop().",
  "The subagent runs inside the parent tool call — abort propagates automatically,",
  "progress streams live to the TUI. No subprocess overhead.",
  "",
  "Two modes:",
  '  1. Agent file: subagent({ name: "recon", agent: "scout", task: "..." }) — tools/capabilities/model/prompt from the agent definition',
  '     `name` is required and creates a persistent `sub-<name>` session beside the parent.',
  '     If the agent file omits model, you MUST pass model explicitly.',
  '  2. Inline: subagent({ name: "task", task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
  '  max_turns is optional; omit it to run without a turn-count limit. Use subagent_start for non-blocking jobs and subagent_job to inspect them.',
  "",
] as const;

export const STATIC_DESCRIPTION = [
  ...DESCRIPTION_INTRO,
  ...formatToolList(),
  "Extension tools are available when registered.",
].join("\n");

function selectModels(enabledModelIds: string[], availableModels: AvailableModel[]): AvailableModel[] {
  if (enabledModelIds.length === 0) return availableModels;
  const enabled = new Set(enabledModelIds);
  return availableModels.filter((model) => enabled.has(`${model.provider}/${model.id}`));
}

function appendModels(
  lines: string[],
  models: AvailableModel[],
  annotations?: Record<string, string[]>,
): void {
  if (models.length === 0) {
    lines.push("", "Model: 'provider/model-id' format. Required — no default.");
    return;
  }

  lines.push("", "Available models (use 'provider/model-id' format):");
  for (const model of models) {
    const modelKey = `${model.provider}/${model.id}`;
    const tags = annotations?.[modelKey];
    const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    lines.push(`  ${modelKey} — ${model.name}${tagSuffix}`);
  }
  lines.push(
    "",
    "Model selection: choose based on task complexity and cost.",
    "  - Models tagged [preferred] are cost-effective — use for gathering, summarization, and mechanical edits.",
    "  - Reserve heavier models for tasks requiring judgment, adversarial thinking, or subtle reasoning.",
    "  - Always pass model explicitly — there is no default.",
  );
}

function formatAgent(agent: AgentConfig): string {
  const metadata: string[] = [];
  if (agent.capabilities?.length) metadata.push(`capabilities: ${agent.capabilities.join(", ")}`);
  if (agent.tools?.length) metadata.push(`tools: ${agent.tools.join(", ")}`);
  metadata.push(agent.model ? `model: ${agent.model}` : "model: REQUIRED — pass model param");
  return `  ${agent.name} (${agent.source}): ${agent.description} [${metadata.join(" | ")}]`;
}

function appendAgents(lines: string[], agents: AgentConfig[]): void {
  if (agents.length === 0) return;
  lines.push("", "Available agents:", ...agents.map(formatAgent));
}

export function buildDynamicDescription(
  enabledModelIds: string[],
  availableModels: AvailableModel[],
  agents: AgentConfig[],
  extensionToolNames?: string[],
  extensionToolCapabilities?: Map<string, ToolCapability[]>,
  modelAnnotations?: Record<string, string[]>,
): string {
  const lines = [
    ...DESCRIPTION_INTRO,
    ...formatToolList(extensionToolNames, extensionToolCapabilities),
  ];
  appendModels(lines, selectModels(enabledModelIds, availableModels), modelAnnotations);
  appendAgents(lines, agents);
  return lines.join("\n");
}
