import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChildContext } from "../_shared/child-context";
import { generateRecap, RecapFailure, recapFailureMessage } from "./recap";

export default function contextRecap(pi: Pick<ExtensionAPI, "on" | "registerCommand">) {
  if (getChildContext()) return;
  let active: AbortController | undefined;
  let generation = 0;
  const invalidate = () => {
    generation++;
    active?.abort();
    active = undefined;
  };
  const rootTui = (ctx: ExtensionContext) => ctx.mode === "tui";

  pi.on("input", invalidate);
  pi.on("before_agent_start", invalidate);
  pi.on("model_select", invalidate);
  pi.on("thinking_level_select", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("ui_prompt_start", invalidate);
  pi.on("session_shutdown", invalidate);

  pi.on("session_before_compact", async (event, ctx) => {
    if (!rootTui(ctx)) return;
    invalidate();
    const operation = new AbortController();
    active = operation;
    const captured = generation;
    const leaf = ctx.sessionManager.getLeafId();
    try {
      const result = await generateRecap(event, ctx, operation.signal);
      if (captured !== generation || leaf !== ctx.sessionManager.getLeafId())
        throw new RecapFailure("cancelled");
      return {
        compaction: {
          ...result,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (error) {
      // Never fall through: native fallback would make a second billable request.
      if (ctx.hasUI) ctx.ui.notify(recapFailureMessage(error), "warning");
      return { cancel: true };
    } finally {
      if (active === operation) active = undefined;
    }
  });

  pi.registerCommand("context-recap", {
    description: "Context recap: status | now | cancel (automatic recap blocked)",
    handler: async (args, ctx) => {
      if (!rootTui(ctx)) {
        if (ctx.hasUI)
          ctx.ui.notify("Context recap is available only in the root TUI session.", "warning");
        return;
      }
      const action = args.trim() || "status";
      if (action === "cancel") {
        if (active) {
          invalidate();
          ctx.ui.notify("Active context recap cancelled.", "info");
        } else {
          ctx.ui.notify("No active context recap to cancel.", "info");
        }
      } else if (action === "now") {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify(
            "Context recap skipped: session must be idle with no queued messages.",
            "warning",
          );
          return;
        }
        ctx.compact({
          onComplete: () => ctx.ui.notify("Context recap saved; recent history retained.", "info"),
          onError: () => ctx.ui.notify("Context recap not saved.", "warning"),
        });
      } else if (action === "status") {
        ctx.ui.notify(
          "Root TUI recap customization active; automatic recap blocked (no atomic idle-only compaction API).",
          "info",
        );
      } else {
        ctx.ui.notify("Usage: /context-recap status|now|cancel", "warning");
      }
    },
  });
}
