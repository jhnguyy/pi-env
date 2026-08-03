import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { buildDynamicDescription } from "../discovery";

describeIfEnabled("subagent", "dynamic model guidance", () => {
  const availableModels = [
    { provider: "test", id: "quick", name: "Quick" },
    { provider: "test", id: "coder", name: "Coder" },
    { provider: "test", id: "deep", name: "Deep" },
    { provider: "test", id: "offline", name: "Offline" },
    { provider: "test", id: "excluded", name: "Excluded" },
  ];

  const annotations = {
    "test/quick": ["preferred", "fast", "experimental"],
    "test/coder": ["codex"],
    "test/deep": ["heavy"],
    "test/offline": ["local", "free"],
    "test/excluded": ["heavy", "free"],
  };

  it("maps known live tags to task intents without hiding unknown tags", () => {
    const description = buildDynamicDescription(
      ["test/quick", "test/coder", "test/deep", "test/offline"],
      availableModels,
      [],
      undefined,
      undefined,
      annotations,
    );

    expect(description).toContain("Available models (use 'provider/model-id' format):");
    expect(description).toContain("test/quick — Quick [preferred, fast, experimental]");
    expect(description).toContain(
      "[preferred] Cost-effective gathering, summarization, and mechanical edits.",
    );
    expect(description).toContain("[fast] Latency-sensitive read-only scouting.");
    expect(description).toContain("[codex] Code-focused reasoning and implementation.");
    expect(description).toContain("[heavy] Judgment, adversarial review, and subtle reasoning.");
    expect(description).toContain("[local] Local execution when remote providers are unnecessary.");
    expect(description).toContain("[free] No-cost iteration.");
    expect(description.match(/experimental/g)).toHaveLength(1);
    expect(description).toContain("Always pass model explicitly — there is no default.");
  });

  it("omits routing guidance for tags that occur only on filtered models", () => {
    const description = buildDynamicDescription(
      ["test/coder"],
      availableModels,
      [],
      undefined,
      undefined,
      annotations,
    );

    expect(description).toContain("[codex] Code-focused reasoning and implementation.");
    expect(description).not.toContain("[preferred] Cost-effective gathering");
    expect(description).not.toContain("[heavy] Judgment");
    expect(description).not.toContain("test/excluded");
  });
});
