type AvailableModel = { provider: string; id: string };

export const STATIC_DESCRIPTION =
  "Delegate tasks to native Pi children. Children load their target cwd/agent configuration. Explicit unavailable model/tool selections fail without substitution.";

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
  modelAnnotations?: Record<string, string[]>,
): string {
  const lines = [STATIC_DESCRIPTION];
  if (availableModels.length) {
    lines.push("", "Model hints, not an allowlist (child availability may differ):");
    for (const model of availableModels) {
      const key = `${model.provider}/${model.id}`;
      const tags = modelAnnotations?.[key] ?? [];
      lines.push(`  ${key}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
    }
    const tags = new Set(availableModels.flatMap((model) => modelAnnotations?.[`${model.provider}/${model.id}`] ?? []));
    const guidance = Object.entries(MODEL_TAG_GUIDANCE).filter(([tag]) => tags.has(tag));
    if (guidance.length) lines.push("", "Model tag guidance:", ...guidance.map(([tag, intent]) => `  - [${tag}] ${intent}.`));
  }
  return lines.join("\n");
}
