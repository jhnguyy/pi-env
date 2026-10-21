type AvailableModel = { provider: string; id: string };

const DESCRIPTION_INTRO = [
  "Delegate to native Pi child sessions through one action-selected interface.",
  "",
  "Actions:",
  "  - run: Wait for the child's initial result.",
  "  - start: Start a background job.",
  "  - status, wait, result, cancel: Manage a background job by job_id.",
  "  - list: List retained jobs. usage: Summarize child usage.",
  "",
  "Children load native configuration and resources for their target cwd and agent directory.",
  "Omit model or tools to use child-native defaults. Explicit unavailable selections fail without substitution.",
  "The required name creates a sub-<name> transcript. /subagents inspects retained children and sends human input directly, without switching the parent session.",
  "Public runs have no turn-count limit. The configured run-time limit still applies.",
] as const;

export const STATIC_DESCRIPTION = DESCRIPTION_INTRO.join("\n");

const MODEL_TAG_GUIDANCE = {
  preferred: "Cost-effective gathering, summarization, and mechanical edits",
  fast: "Latency-sensitive scouting",
  codex: "Code-focused reasoning and implementation",
  heavy: "Judgment, adversarial review, and subtle reasoning",
  local: "Local execution when remote providers are unnecessary",
  free: "No-cost iteration",
} as const;

export function buildDynamicDescription(
  availableModels: AvailableModel[],
  toolNames: string[] = [],
  modelAnnotations?: Record<string, string[]>,
  scoped = false,
): string {
  const lines: string[] = [...DESCRIPTION_INTRO];
  if (toolNames.length) lines.push("", `Parent native tools (guidance, not the child's catalog): ${toolNames.join(", ")}.`);
  if (availableModels.length) {
    lines.push("", `Parent ${scoped ? "scoped" : "available"} models (children resolve against their own native configuration):`);
    for (const model of availableModels) {
      const key = `${model.provider}/${model.id}`;
      const tags = modelAnnotations?.[key] ?? [];
      lines.push(`  ${key}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
    }
    if (scoped) lines.push("Other available models also work. An unavailable selection fails and lists the available models.");
    const tags = new Set(availableModels.flatMap((model) => modelAnnotations?.[`${model.provider}/${model.id}`] ?? []));
    const guidance = Object.entries(MODEL_TAG_GUIDANCE).filter(([tag]) => tags.has(tag));
    if (guidance.length) lines.push("", "Model tag guidance:", ...guidance.map(([tag, intent]) => `  - [${tag}] ${intent}.`));
  }
  return lines.join("\n");
}
