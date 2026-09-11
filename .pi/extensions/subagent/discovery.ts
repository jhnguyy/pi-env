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
  "Run and manage focused in-process subagents through one action-selected interface.",
  "",
  "Actions:",
  '  - run: Wait for one child result. Example: subagent({ action: "run", name: "recon", agent: "scout", task: "..." }).',
  '  - start: Start a session-scoped background job. Example: subagent({ action: "start", name: "recon", agent: "scout", task: "..." }).',
  "  - status, wait, result, or cancel: Manage one background job by job_id.",
  "  - list: List retained jobs.",
  "  - usage: Summarize aggregate subagent usage for the parent session.",
  "",
  "For run/start, agent files provide tools, capabilities, model, and prompt defaults.",
  "User and installed package agents are the default. Project agents require agent_scope and project trust.",
  "For a persistent parent, the required name creates a `sub-<name>` transcript below the parent's `_children` directory.",
  "If the agent file omits model, you MUST pass model explicitly.",
  'Inline run/start calls require tools and model. Example: subagent({ action: "run", name: "task", task: "...", tools: [...], model: "provider/id" }).',
  "Public runs have no turn-count limit. The configured run-time limit still applies.",
  "",
] as const;

export const STATIC_DESCRIPTION = [
  ...DESCRIPTION_INTRO,
  ...formatToolList(),
  "Extension tools are available when registered.",
].join("\n");

function selectModels(
  enabledModelIds: string[],
  availableModels: AvailableModel[],
): AvailableModel[] {
  if (enabledModelIds.length === 0) return availableModels;
  const enabled = new Set(enabledModelIds);
  return availableModels.filter((model) => enabled.has(`${model.provider}/${model.id}`));
}

const MODEL_TAG_GUIDANCE = {
  preferred: "Cost-effective gathering, summarization, and mechanical edits",
  fast: "Latency-sensitive read-only scouting",
  codex: "Code-focused reasoning and implementation",
  heavy: "Judgment, adversarial review, and subtle reasoning",
  local: "Local execution when remote providers are unnecessary",
  free: "No-cost iteration",
} as const;

const ModelPolicyTag = {
  Reviewer: "reviewer",
} as const;
const MODEL_POLICY_TAGS: ReadonlySet<string> = new Set(Object.values(ModelPolicyTag));

function modelDescriptionTags(tags?: readonly string[]): string[] {
  return tags?.filter((tag) => !MODEL_POLICY_TAGS.has(tag)) ?? [];
}

function appendModelTagGuidance(
  lines: string[],
  models: AvailableModel[],
  annotations?: Record<string, string[]>,
): boolean {
  const availableTags = new Set(
    models.flatMap((model) => modelDescriptionTags(annotations?.[`${model.provider}/${model.id}`])),
  );
  const guidance = Object.entries(MODEL_TAG_GUIDANCE).filter(([tag]) => availableTags.has(tag));
  if (guidance.length === 0) return false;

  lines.push(
    "",
    "Model tag guidance:",
    ...guidance.map(([tag, intent]) => `  - [${tag}] ${intent}.`),
  );
  return true;
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
    const tags = modelDescriptionTags(annotations?.[modelKey]);
    const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    lines.push(`  ${modelKey} — ${model.name}${tagSuffix}`);
  }
  const hasTagGuidance = appendModelTagGuidance(lines, models, annotations);
  lines.push(
    "",
    hasTagGuidance
      ? "Model selection: match task intent to the available tags and cost."
      : "Model selection: choose based on task complexity and cost.",
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
