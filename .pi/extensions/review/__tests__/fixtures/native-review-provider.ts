import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type FauxResponseFactory,
  type TranscriptContext,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewDeck } from "../../deck";
import type { reviewerDossierContext } from "../../reviewer-dossier";

export const ParentProvider = "a-parent-fixture";
export const SignedOutProvider = "b-signed-out-fixture";
export const ReviewProvider = "z-review-fixture";

function text(message: TranscriptContext["messages"][number]): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}

/** Script inference from real tool results. Never read or manufacture review artifacts. */
export default function nativeReviewProvider(pi: ExtensionAPI) {
  const parent = fauxProvider({ provider: ParentProvider });
  const reviewer = fauxProvider({ provider: ReviewProvider });
  const signedOut = fauxProvider({ provider: SignedOutProvider });
  const respond: FauxResponseFactory = (context, _options, _state, model) => {
    pi.appendEntry("review-fixture-request", { provider: model.provider });
    const tools = getCurrentTools(context.messages);
    const tool = (prefix: string) => {
      const found = tools.find((candidate) => candidate.name.startsWith(prefix));
      if (!found) throw new Error(`Missing native review tool: ${prefix}`);
      return found.name;
    };
    const call = (prefix: string, args: ToolCall["arguments"] = {}) =>
      fauxAssistantMessage(fauxToolCall(tool(prefix), args), { stopReason: "toolUse" });
    const last = context.messages.at(-1);
    if (last?.role === "toolResult" && last.isError)
      throw new Error(`Native review tool failed: ${text(last)}`);
    if (model.provider === ParentProvider) {
      if (last?.role === "toolResult" && last.toolName === "review")
        return fauxAssistantMessage("Public review completed.");
      return call("review", {
        command: "pr",
        action: "create",
        url: "https://github.com/acme/widgets/pull/7",
      });
    }
    if (last?.role === "toolResult") {
      if (last.toolName.startsWith("submit_review_")) return fauxAssistantMessage(text(last));
      if (last.toolName.startsWith("review_deck_")) {
        const deck = JSON.parse(text(last)) as ReviewDeck;
        return call("submit_review_plan_", {
          goal: "Change the exported value.",
          goalAssessment: "The pinned diff changes the value.",
          risk: "low",
          riskReasons: [],
          cohorts: [
            {
              label: "implementation",
              purpose: "Review the changed code",
              paths: deck.files.map((file) => file.path),
            },
          ],
          files: deck.files.map((file) => ({
            path: file.path,
            attention: "high",
            role: "implementation",
          })),
          evidence: deck.files.flatMap((file) =>
            (file.diffHunks ?? []).map(([startLine, endLine]) => ({
              kind: "diff",
              path: file.path,
              startLine,
              endLine,
              purpose: "Complete pinned hunk",
            })),
          ),
        });
      }
      if (last.toolName.startsWith("review_result_refs_")) {
        const dossier = JSON.parse(text(last)) as ReturnType<typeof reviewerDossierContext>;
        return call("submit_review_synthesis_", {
          v: 2,
          verdict: "Native review retained one actionable finding.",
          coverage: {
            status: "complete",
            succeeded: dossier.succeeded.map((item) => item.role),
            failed: [],
            malformed: [],
          },
          findings: dossier.succeeded.flatMap((item) =>
            item.rawFindings.map((raw) => ({ ...raw.finding, rawFindingIds: [raw.id] })),
          ),
          dismissals: [],
        });
      }
      throw new Error(`Unexpected native review tool result: ${last.toolName}`);
    }
    if (tools.some((candidate) => candidate.name.startsWith("submit_review_plan_")))
      return call("review_deck_");
    if (tools.some((candidate) => candidate.name.startsWith("submit_review_synthesis_")))
      return call("review_result_refs_");
    const user = [...context.messages].reverse().find((message) => message.role === "user");
    if (!user) throw new Error("Missing native DAG task");
    const task = JSON.parse(text(user)) as {
      instructions: string;
      context: { outputName: string; text: string }[];
    };
    const role =
      /Review only the (\S+) dimension/u.exec(task.instructions)?.[1] ??
      (task.instructions.includes("Review the whole change independently")
        ? "whole-change"
        : undefined);
    const evidence = task.context.find((item) => item.outputName === "evidence_coverage");
    if (!role || !evidence || tools.length) throw new Error("Invalid tool-free reviewer request");
    return fauxAssistantMessage(
      JSON.stringify({
        role,
        evidenceDigest: JSON.parse(evidence.text).digest,
        verdict: `${role} reviewed`,
        findings:
          role === "correctness"
            ? [
                {
                  severity: "serious",
                  impact: "high",
                  file: "a.ts",
                  side: "RIGHT",
                  line: 1,
                  problem: "The exported value violates the requested contract.",
                  consequence: "Callers receive the wrong value.",
                  suggestedFix: "Restore the requested value.",
                },
              ]
            : [],
      }),
    );
  };
  for (const provider of [parent, reviewer]) {
    provider.setResponses(Array.from({ length: 16 }, () => respond));
    pi.registerProvider(provider.provider);
  }
  pi.registerProvider({
    ...signedOut.provider,
    auth: { apiKey: { name: "Signed-out fixture", resolve: async () => undefined } },
  });
}
