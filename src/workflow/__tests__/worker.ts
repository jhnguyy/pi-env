import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { openWorkflowHost } from "../host.js";
import { ThreeStageWorkflow } from "../definition.js";

const [directory, mode, override] = process.argv.slice(2);
const bundleId =
  override ||
  createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex");
const faux = fauxProvider({ api: "workflow-proof", models: [{ id: "workflow-proof" }] });
const calls: { stage: string; input: string; tools: string[]; baseUrl: string }[] = [];
let release: () => void = () => {};
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let atConfirm: () => void = () => {};
const confirmed = new Promise<void>((resolve) => {
  atConfirm = resolve;
});

for (let index = 0; index < 12; index++) {
  faux.appendResponses([
    async (context, options, _state, model) => {
      const user = context.messages.find((message) => message.role === "user");
      const input = user?.role === "user" && typeof user.content === "string" ? user.content : "";
      const payload: unknown = JSON.parse(input);
      const Prompt = Type.Object({
        stage: Type.String(),
        input: Type.String(),
        dependencies: Type.Array(Type.Unknown()),
      });
      if (!Check(Prompt, payload)) throw new Error("Invalid workflow prompt");
      const stage = payload.stage;
      calls.push({
        stage,
        input,
        baseUrl: model.baseUrl,
        tools: context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        ),
      });
      if (stage === "confirm") {
        atConfirm();
        if (mode === "hold-confirm") {
          await Promise.race([
            held,
            new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        }
      }
      if (stage === "triage" && mode === "fail-triage")
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Synthetic triage failure",
        });
      switch (stage) {
        case "triage":
          return fauxAssistantMessage("Triage artifact");
        case "confirm":
          return fauxAssistantMessage("Confirmation artifact");
        case "present":
          return fauxAssistantMessage(
            mode === "empty-present"
              ? ""
              : mode === "oversized-present"
                ? "x".repeat(8_193)
                : mode === "fail-triage"
                  ? "Presentation: triage failed; confirmation was blocked."
                  : "Presentation: confirmed synthetic change.",
          );
        default:
          throw new Error(`Unknown stage: ${stage}`);
      }
    },
  ]);
}

const definition = structuredClone(ThreeStageWorkflow);
switch (mode) {
  case "invalid-cycle":
    definition.nodes[0].dependencies = [{ nodeId: "confirm", mode: "required" }];
    break;
  case "invalid-duplicate":
    definition.nodes[1].id = "triage";
    break;
  case "invalid-missing":
    definition.nodes[1].dependencies[0].nodeId = "absent";
    break;
  case "invalid-uncovered":
    definition.presenter = "triage";
    break;
  case "invalid-oversized":
    definition.nodes = Array.from({ length: 17 }, () => definition.nodes[0]);
    break;
}
const hostOptions = {
  directory,
  bundleId,
  provider: faux.provider,
  model: { provider: "faux", modelId: "workflow-proof" },
  definitions: [definition],
};
const host = openWorkflowHost(hostOptions);
// Attach immediately so a failed open cannot become an unhandled rejection before the readiness request.
void host.catch(() => {});
const Message = Type.Object({
  id: Type.Integer(),
  action: Type.String(),
  value: Type.Optional(Type.Unknown()),
});
process.on("message", (message: unknown) => {
  if (!Check(Message, message)) throw new Error("Invalid test IPC request");
  void (async () => {
    const opened = await host;
    switch (message.action) {
      case "ready":
        return true;
      case "submit":
        return opened.submit(message.value);
      case "status": {
        const request = message.value;
        if (!Check(Type.Object({ principal: Type.String(), reference: Type.Unknown() }), request))
          throw new Error("Invalid status request");
        return opened.status(request.principal, request.reference);
      }
      case "wait": {
        const request = message.value;
        if (!Check(Type.Object({ principal: Type.String(), reference: Type.Unknown() }), request))
          throw new Error("Invalid wait request");
        return opened.wait(request.principal, request.reference);
      }
      case "replace-provider": {
        const replacement = fauxProvider({
          api: "replacement",
          models: [{ id: "workflow-proof" }],
        });
        replacement.models[0].baseUrl = "http://replacement.invalid";
        replacement.setResponses([fauxAssistantMessage("Replacement artifact")]);
        hostOptions.provider = replacement.provider;
        faux.models[0].baseUrl = "http://mutated.invalid";
        return true;
      }
      case "wait-mutated": {
        const request = message.value;
        const Reference = Type.Object({ serviceId: Type.String(), runId: Type.Integer() });
        if (
          !Check(
            Type.Object({ principal: Type.String(), reference: Reference, other: Reference }),
            request,
          )
        )
          throw new Error("Invalid mutation request");
        const waiting = opened.wait(request.principal, request.reference);
        Object.assign(request.reference, request.other);
        return waiting;
      }
      case "calls":
        return calls;
      case "at-confirm":
        await confirmed;
        return true;
      case "release":
        release();
        return true;
      case "close":
        await opened.close();
        return true;
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  })().then(
    (value) => process.send?.({ id: message.id, value }),
    (error: unknown) =>
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
