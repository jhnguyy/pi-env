import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChildContext } from "../_shared/child-context";
import { generateRecap, RecapFailure, recapFailureMessage } from "./recap";
import { modelKey, requestLifetime } from "./lifetime";
import { loadPolicy } from "./config";

type Reservation = {
  done: Promise<void>;
  release(): void;
  invalidated: boolean;
};
type Request = { anchor: number; key: string; ttl: ReturnType<typeof requestLifetime> };
type Run = { generation: number; request?: Request };

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

function identity(ctx: ExtensionContext): string {
  return JSON.stringify([
    modelKey(ctx),
    ctx.thinkingLevel,
    ctx.sessionManager.getSessionId(),
    ctx.sessionManager.getLeafId(),
  ]);
}

export default function contextRecap(pi: Pick<ExtensionAPI, "on" | "registerCommand">) {
  if (getChildContext()) return;
  let disposed = false;
  let active: AbortController | undefined;
  let reservation: Reservation | undefined;
  let candidate: { timer: ReturnType<typeof setTimeout>; description: string } | undefined;
  let generation = 0;
  let run: Run | undefined;
  // Ordinary TUI input is serial: a later idle submission supersedes a consumed
  // or failed preflight. Native idle alone cannot resolve the latest preflight.
  let preflightPending = false;
  let uiBusy = false;
  let reason = "waiting for a fresh successful run";
  const rootTui = (ctx: ExtensionContext) => ctx.mode === "tui" && !disposed;
  const clear = () => {
    if (candidate) clearTimeout(candidate.timer);
    candidate = undefined;
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
    const started: Run = { generation };
    run = started; // Own the starting span too, including the native-release await.
    if (reservation) await reservation.done;
    if (generation === started.generation) preflightPending = false;
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!rootTui(ctx)) return;
    clear();
    if (!run || reservation) return;
    // Custom transports may omit the payload hook. This early anchor is only
    // an estimate, not evidence that a network request was sent.
    run.request = { anchor: Date.now(), key: modelKey(ctx), ttl: undefined };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!rootTui(ctx) || !run || reservation) return;
    run.request = {
      anchor: Date.now(),
      key: modelKey(ctx),
      ttl: requestLifetime(event.payload, ctx.model),
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!rootTui(ctx)) return;
    const settled = run;
    run = undefined;
    const fresh = settled?.request;
    const suppressed = preflightPending || settled?.generation !== generation;
    if (suppressed) reason = "unresolved latest input preflight; waiting for a successful run";
    if (suppressed || event.aborted || !fresh || busy(ctx)) return;
    if (!completedWithSelectedModel(ctx) || fresh.key !== modelKey(ctx)) return;
    preflightPending = false;
    reason = "fresh successful run; automatic scheduling off";
    arm(fresh, ctx);
  });

  const arm = (fresh: Request, ctx: ExtensionContext) => {
    const policy = loadPolicy(ctx.cwd, ctx.model);
    if (policy.blocked || !policy.enabled) {
      reason = policy.blocked ?? "automatic scheduling off for this provider";
      return;
    }
    const ttl = typeof fresh.ttl === "string" ? undefined : (fresh.ttl ?? policy.estimate);
    if (!ttl) {
      reason = "cache lifetime unknown or caching disabled";
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
    const captured = identity(ctx);
    const armedGeneration = generation;
    const description = `scheduled for ${new Date(target).toISOString()}; TTL ${ttl / 1000}s; source: ${fresh.ttl === undefined ? policy.source : "request cache metadata"}`;
    const timer = setTimeout(() => {
      clear();
      const now = Date.now();
      reason = "candidate consumed; waiting for a fresh successful run";
      if (
        !rootTui(ctx) ||
        preflightPending ||
        run ||
        busy(ctx) ||
        now < target ||
        now < armedAt ||
        now > latest ||
        generation !== armedGeneration ||
        captured !== identity(ctx)
      )
        return;
      const current = loadPolicy(ctx.cwd, ctx.model);
      if (JSON.stringify(current) !== JSON.stringify(policy)) {
        reason = current.blocked ?? "automatic policy changed; waiting for a fresh successful run";
        return;
      }
      launch(ctx);
    }, target - armedAt);
    timer.unref();
    candidate = { timer, description };
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
  pi.on("model_select", activity);
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
    const captured = generation;
    const capturedIdentity = identity(ctx);
    try {
      const result = await generateRecap(event, ctx, operation.signal);
      if (captured !== generation || capturedIdentity !== identity(ctx))
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
      if (rootTui(ctx) && ctx.hasUI) ctx.ui.notify(recapFailureMessage(error), "warning");
      return { cancel: true };
    } finally {
      if (active === operation) active = undefined;
    }
  });

  pi.registerCommand("context-recap", {
    description: "Show automatic context recap status",
    handler: async (args, ctx) => {
      if (!rootTui(ctx)) {
        if (ctx.hasUI)
          ctx.ui.notify("Context recap is available only in the root TUI session.", "warning");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Usage: /context-recap (status only; no arguments)", "warning");
        return;
      }
      const policy = loadPolicy(ctx.cwd, ctx.model);
      const state = active
        ? "generating"
        : reservation
          ? "compacting"
          : (candidate?.description ?? reason);
      ctx.ui.notify(
        `Automatic context recap ${policy.blocked ? "suppressed" : policy.enabled ? "enabled" : "disabled"}; ${state}.${policy.blocked ? ` ${policy.blocked}.` : ""}${!candidate && policy.source ? ` Source: ${policy.source}.` : ""}`,
        "info",
      );
    },
  });
}
