import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChildContext } from "../_shared/child-context";
import { generateRecap, RecapFailure, recapFailureMessage } from "./recap";
import { duration, modelKey, requestLifetime, warmingBlock } from "./lifetime";

type Reservation = {
  done: Promise<void>;
  release(): void;
  invalidated: boolean;
  phase: "acquiring" | "generating" | "handed-off";
};
type Request = { anchor: number; key: string; ttl: number | "off" | undefined; generation: number };

function completedWithSelectedModel(ctx: ExtensionContext): boolean {
  const last = ctx.sessionManager.buildSessionProjection().messages.at(-1);
  if (last?.role !== "assistant" || !ctx.model) return false;
  return (
    last.stopReason === "stop" &&
    !last.errorMessage &&
    !last.content.some((part) => part.type === "toolCall") &&
    last.provider === ctx.model.provider &&
    last.model === ctx.model.id
  );
}

function captureContext(ctx: ExtensionContext) {
  const captured = JSON.stringify([
    modelKey(ctx),
    ctx.thinkingLevel,
    ctx.sessionManager.getSessionId(),
    ctx.sessionManager.getLeafId(),
  ]);
  return () =>
    captured ===
    JSON.stringify([
      modelKey(ctx),
      ctx.thinkingLevel,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getLeafId(),
    ]);
}

export default function contextRecap(pi: Pick<ExtensionAPI, "on" | "registerCommand">) {
  if (getChildContext()) return;
  let enabled = false;
  let disposed = false;
  let active: AbortController | undefined;
  let reservation: Reservation | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let request: Request | undefined;
  let estimate: { key: string; ttl: number } | undefined;
  // Ordinary TUI input is serial: a later idle submission supersedes a consumed
  // or failed preflight. Native idle alone cannot resolve the latest preflight.
  let preflightPending = false;
  let runGeneration: number | undefined;
  let running = false;
  let uiBusy = false;
  let reason = "waiting for a fresh successful run";
  const rootTui = (ctx: ExtensionContext) => ctx.mode === "tui" && !disposed;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    request = undefined;
  };
  const invalidate = () => {
    clear();
    generation++;
    if (reservation) reservation.invalidated = true;
    active?.abort();
    active = undefined;
    reason = "activity changed; waiting for a fresh successful run";
  };
  const busy = (ctx: ExtensionContext) =>
    reservation || uiBusy || !ctx.isIdle() || ctx.hasPendingMessages();
  const launch = (ctx: ExtensionContext) => {
    if (!rootTui(ctx) || busy(ctx)) return;
    clear();
    let release!: () => void;
    const owned: Reservation = {
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
      invalidated: false,
      phase: "acquiring",
    };
    reservation = owned;
    const finish = (success: boolean) => {
      owned.release();
      if (reservation !== owned) return;
      reservation = undefined;
      reason = success
        ? "recap saved; waiting for a fresh successful run"
        : "recap not saved; waiting for a fresh successful run";
      if (rootTui(ctx))
        ctx.ui.notify(
          success ? "Context recap saved; recent history retained." : "Context recap not saved.",
          success ? "info" : "warning",
        );
    };
    // Acquisition and the public native call must share this JS stack. Input gates
    // wait for terminal callbacks, not for our summary proposal to return.
    try {
      ctx.compact({ onComplete: () => finish(true), onError: () => finish(false) });
    } catch {
      finish(false);
    }
  };

  pi.on("input", async (_event, ctx) => {
    if (!rootTui(ctx)) return;
    invalidate(); // Cancel synchronously before awaiting native ownership release.
    preflightPending = true;
    reason = "unresolved latest input preflight; waiting for a successful run";
    if (reservation) await reservation.done;
    return { action: "continue" };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!rootTui(ctx)) return;
    invalidate();
    const started = generation;
    if (reservation) await reservation.done;
    if (generation === started) preflightPending = false;
    runGeneration = started;
    running = true;
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!rootTui(ctx)) return;
    clear();
    if (!running || reservation) return;
    // Custom transports may omit the payload hook. This early anchor is only
    // an estimate, not evidence that a network request was sent.
    request = { anchor: Date.now(), key: modelKey(ctx), ttl: undefined, generation };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!rootTui(ctx) || !running || reservation) return;
    request = {
      anchor: Date.now(),
      key: modelKey(ctx),
      ttl: requestLifetime(event.payload, ctx.model),
      generation,
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!rootTui(ctx)) return;
    running = false;
    const fresh = request;
    request = undefined;
    const suppressed = preflightPending || runGeneration !== generation;
    runGeneration = undefined;
    if (suppressed) reason = "unresolved latest input preflight; waiting for a successful run";
    if (suppressed || event.aborted || !fresh || fresh.generation !== generation || busy(ctx))
      return;
    if (!completedWithSelectedModel(ctx) || fresh.key !== modelKey(ctx)) return;
    preflightPending = false;
    reason = "fresh successful run; automatic scheduling off";
    if (enabled) arm(fresh, ctx);
  });

  const arm = (fresh: Request, ctx: ExtensionContext) => {
    const ttl =
      fresh.ttl === "off"
        ? undefined
        : (fresh.ttl ?? (estimate?.key === fresh.key ? estimate.ttl : undefined));
    if (!ttl) {
      reason =
        "cache lifetime unknown or caching disabled; optionally use on <duration> for an unknown endpoint";
      return;
    }
    const lead = Math.max(30_000, ttl * 0.1);
    const target = fresh.anchor + ttl - lead;
    const latest = target + lead / 2;
    const armedAt = Date.now();
    if (ttl <= lead || armedAt >= target || armedAt < fresh.anchor) {
      reason = "cache window missed or too short";
      return;
    }
    const blocked = warmingBlock(ctx.cwd);
    if (blocked) {
      reason = blocked;
      return;
    }
    const contextUnchanged = captureContext(ctx);
    reason = `scheduled for ${new Date(target).toISOString()}; TTL ${ttl / 1000}s; source: ${fresh.ttl === undefined ? "user estimate (not a guarantee)" : "request cache metadata"}`;
    timer = setTimeout(() => {
      timer = undefined;
      const now = Date.now();
      reason = "candidate consumed; waiting for a fresh successful run";
      if (
        !rootTui(ctx) ||
        !enabled ||
        preflightPending ||
        running ||
        busy(ctx) ||
        now < target ||
        now < armedAt ||
        now > latest ||
        generation !== fresh.generation ||
        !contextUnchanged()
      )
        return;
      const blockedNow = warmingBlock(ctx.cwd);
      if (blockedNow) {
        reason = blockedNow;
        return;
      }
      launch(ctx);
    }, target - armedAt);
    timer.unref();
  };

  const activity = (_event: unknown, ctx: ExtensionContext) => {
    if (rootTui(ctx)) invalidate();
  };
  pi.on("thinking_level_select", activity);
  pi.on("session_before_tree", activity);
  pi.on("session_tree", activity);
  pi.on("session_before_switch", activity);
  pi.on("session_before_fork", activity);
  pi.on("user_bash", activity);
  pi.on("model_select", (_event, ctx) => {
    if (!rootTui(ctx)) return;
    estimate = undefined;
    invalidate();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (rootTui(ctx)) {
      uiBusy = true;
      invalidate();
    }
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (rootTui(ctx)) uiBusy = false;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui" || disposed) return;
    disposed = true;
    enabled = false;
    invalidate();
    reservation?.release();
    reservation = undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!rootTui(ctx)) return;
    const owned = reservation;
    // Never reset a reservation's early cancellation when native acquisition
    // finally reaches this hook. Only native terminal callbacks release it.
    if (owned?.invalidated) return { cancel: true };
    if (!owned) invalidate();
    const operation = new AbortController();
    active = operation;
    if (owned) owned.phase = "generating";
    const captured = generation;
    const leaf = ctx.sessionManager.getLeafId();
    try {
      const result = await generateRecap(event, ctx, operation.signal);
      if (captured !== generation || leaf !== ctx.sessionManager.getLeafId())
        throw new RecapFailure("cancelled");
      if (owned) owned.phase = "handed-off";
      return {
        compaction: {
          ...result,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (error) {
      // Never fall through: native fallback would make a second billable request.
      if (rootTui(ctx) && ctx.hasUI) ctx.ui.notify(recapFailureMessage(error), "warning");
      return { cancel: true };
    } finally {
      if (active === operation) active = undefined;
    }
  });

  const turnOn = (lifetime: string | undefined, ctx: ExtensionContext) => {
    const ttl = lifetime ? duration(lifetime) : undefined;
    if (lifetime && (!ttl || !ctx.model)) {
      ctx.ui.notify(
        "Use a lifetime longer than 30s, such as 5m, with a selected model.",
        "warning",
      );
      return;
    }
    invalidate();
    enabled = true;
    estimate = ttl ? { key: modelKey(ctx), ttl } : undefined;
    ctx.ui.notify(
      `Automatic context recap on for future fresh successful runs${ttl ? "; user estimate, not a cache guarantee" : ""}.`,
      "info",
    );
  };
  const cancel = (off: boolean, ctx: ExtensionContext) => {
    const wasActive = !!active || !!reservation;
    const wasScheduled = timer !== undefined;
    const handedOff = reservation?.phase === "handed-off";
    invalidate();
    if (off) {
      enabled = false;
      estimate = undefined;
    }
    let message = off
      ? "Automatic context recap off."
      : wasScheduled
        ? "Scheduled context recap cancelled."
        : "No active context recap to cancel.";
    if (wasActive)
      message = `${off ? "Automatic context recap off. " : ""}Active context recap cancelled.`;
    if (handedOff)
      message = `${off ? "Automatic context recap off. " : ""}Recap proposal handed to Pi; cannot retract it here. Native Esc can cancel compaction.`;
    ctx.ui.notify(message, "info");
  };
  const now = (ctx: ExtensionContext) => {
    invalidate();
    if (busy(ctx) || preflightPending || running) {
      ctx.ui.notify(
        "Context recap skipped: session must be idle with no queued messages.",
        "warning",
      );
      return;
    }
    launch(ctx);
  };
  const status = (ctx: ExtensionContext) => {
    let state = reason;
    if (preflightPending) state = "unresolved latest input preflight; waiting for a successful run";
    if (active) state = "generating";
    if (reservation) {
      state = reservation.phase;
      if (reservation.invalidated) state += "; cancellation requested (native completion pending)";
    }
    ctx.ui.notify(
      `Automatic context recap ${enabled ? "on" : "off"}; ${state}.${estimate ? " Current-model user estimate (not a guarantee)." : ""}`,
      "info",
    );
  };

  pi.registerCommand("context-recap", {
    description: "Context recap: on [duration] | off | status | now | cancel",
    handler: async (args, ctx) => {
      if (!rootTui(ctx)) {
        if (ctx.hasUI)
          ctx.ui.notify("Context recap is available only in the root TUI session.", "warning");
        return;
      }
      const [action = "status", lifetime, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || (lifetime && action !== "on")) {
        ctx.ui.notify("Usage: /context-recap on [duration]|off|status|now|cancel", "warning");
        return;
      }
      switch (action) {
        case "on":
          turnOn(lifetime, ctx);
          break;
        case "off":
          cancel(true, ctx);
          break;
        case "cancel":
          cancel(false, ctx);
          break;
        case "now":
          now(ctx);
          break;
        case "status":
          status(ctx);
          break;
        default:
          ctx.ui.notify("Usage: /context-recap on [duration]|off|status|now|cancel", "warning");
      }
    },
  });
}
