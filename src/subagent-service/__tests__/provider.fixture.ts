import { existsSync, watch, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Inference and the external tool are synthetic; session ownership and persistence are not.
export default function provider(pi: ExtensionAPI): void {
  const root = process.env.SUBAGENT_FIXTURE_ROOT!;
  const p = fauxProvider({ provider: "service-fixture" });
  pi.registerProvider(p.provider);
  pi.on("session_shutdown", async () => { await appendFile(join(root, "requests.jsonl"), JSON.stringify({ calls: p.state.callCount }) + "\n"); });
  pi.registerTool({
    name: "fixture_gate", label: "Gate", description: "Record one external effect, then await release",
    parameters: Type.Object({ cooperative: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      await appendFile(join(root, "effects.jsonl"), JSON.stringify({ effect: "gate" }) + "\n");
      await writeFile(join(root, "entered"), "ready");
      await new Promise<void>((resolve) => {
        const finish = () => { watcher.close(); signal?.removeEventListener("abort", aborted); resolve(); };
        const aborted = () => {
          writeFileSync(join(root, "aborted"), "abort observed");
          if (params.cooperative !== false) finish();
        };
        const check = () => { if (existsSync(join(root, "release")) || (signal?.aborted && params.cooperative !== false)) finish(); };
        const watcher = watch(root, check);
        signal?.addEventListener("abort", aborted, { once: true });
        check();
      });
      return { content: [{ type: "text", text: "external effect settled" }], details: {} };
    },
  });
  const hold = async (marker: string) => {
    await writeFile(join(root, marker), "ready");
    await new Promise<void>((resolve) => {
      const check = () => { if (existsSync(join(root, "release"))) { watcher.close(); resolve(); } };
      const watcher = watch(root, check);
      check();
    });
  };
  pi.on("session_start", async () => {
    if (existsSync(join(root, "hold-startup"))) await hold("startup-entered");
  });
  pi.on("input", async (event) => {
    if (event.text === "blocked preflight") {
      await hold("preflight-entered");
      p.setResponses([fauxAssistantMessage(fauxToolCall("fixture_gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage("unexpected inference")]);
    }
    if (event.text === "blocked initial") p.setResponses([
      fauxAssistantMessage(fauxToolCall("fixture_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("initial answer"),
      fauxAssistantMessage("follow-up answer"),
    ]);
    if (event.text === "uncooperative initial") p.setResponses([
      fauxAssistantMessage(fauxToolCall("fixture_gate", { cooperative: false }), { stopReason: "toolUse" }),
      fauxAssistantMessage("initial answer"),
    ]);
    if (event.text === "human later") p.setResponses([fauxAssistantMessage("later answer")]);
    if (event.text === "human failure") p.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic provider failure" })]);
    if (event.text === "fresh work") p.setResponses([fauxAssistantMessage("fresh answer")]);
  });
}
