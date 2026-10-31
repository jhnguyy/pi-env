import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";

import type { SubagentRuntimeConfig } from "./config";
import type { UsageStats } from "./types";
import * as ChildTypes from "./child-types";
import { addUsage, zeroUsage } from "./usage";

export const WorkspaceAccess = {
  Read: "read",
  Write: "write",
} as const;
export type WorkspaceAccess = (typeof WorkspaceAccess)[keyof typeof WorkspaceAccess];

export class SubagentAdmissionError extends Data.TaggedError("SubagentAdmissionError")<{
  readonly reason: "closed" | "capacity" | "aborted";
  readonly message: string;
}> {}

export interface SubagentAdmissionRequest {
  readonly runId?: string;
  readonly cwd: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly signal?: AbortSignal;
  readonly scopeId?: string;
  readonly limits?: SubagentRuntimeConfig;
}

export interface SubagentRunLease {
  readonly runId: string;
  readonly signal: AbortSignal;
  updateUsage(usage: UsageStats): void;
  release(usage?: UsageStats): void;
}

interface PendingAdmission {
  readonly request: SubagentAdmissionRequest;
  readonly runId: string;
  readonly resolve: (lease: SubagentRunLease) => void;
  readonly reject: (error: SubagentAdmissionError) => void;
  cleanupAbort?: () => void;
}

interface ActiveRun {
  readonly request: SubagentAdmissionRequest;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
  usage: UsageStats;
  released: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}


function cloneUsage(usage: UsageStats): UsageStats {
  return { ...usage };
}

function canonicalWorkspaceKey(cwd: string): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {}
  let current = resolved;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

function addUsageDelta(total: UsageStats, previous: UsageStats, next: UsageStats): void {
  total.input += Math.max(0, next.input - previous.input);
  total.output += Math.max(0, next.output - previous.output);
  total.cacheRead += Math.max(0, next.cacheRead - previous.cacheRead);
  total.cacheWrite += Math.max(0, next.cacheWrite - previous.cacheWrite);
  total.cost += Math.max(0, next.cost - previous.cost);
  total.turns += Math.max(0, next.turns - previous.turns);
}


export class SubagentRunSupervisor {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pending: PendingAdmission[] = [];
  private readonly activeWorkspaceWriters = new Set<string>();
  private readonly totalUsage = zeroUsage();
  private readonly usageByRun = new Map<string, UsageStats>();
  readonly children = new Map<string, ChildTypes.NativeChildSession>();
  private readonly evicting = new Set<string>();
  private readonly childRetention = new Map<string, { scopeId: string; maxRetained: number }>();
  private readonly evictionFailures: Error[] = [];
  private omittedEvictionFailures = 0;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    readonly sessionId: string,
    readonly config: SubagentRuntimeConfig,
  ) {}

  acquireEffect(
    request: SubagentAdmissionRequest,
  ): Effect.Effect<SubagentRunLease, SubagentAdmissionError> {
    return Effect.tryPromise({
      try: (effectSignal) =>
        this.acquire({
          ...request,
          signal: request.signal
            ? AbortSignal.any([request.signal, effectSignal])
            : effectSignal,
        }),
      catch: (cause) =>
        cause instanceof SubagentAdmissionError
          ? cause
          : new SubagentAdmissionError({ reason: "closed", message: String(cause) }),
    });
  }

  acquire(request: SubagentAdmissionRequest): Promise<SubagentRunLease> {
    const cwd = canonicalWorkspaceKey(request.cwd);
    const normalizedRequest = cwd === request.cwd ? request : { ...request, cwd };
    const rejected = this.rejection(normalizedRequest);
    if (rejected) return Promise.reject(rejected);
    const runId = normalizedRequest.runId ?? randomUUID();
    return new Promise<SubagentRunLease>((resolve, reject) => {
      const pending: PendingAdmission = { request: normalizedRequest, runId, resolve, reject };
      const onAbort = () => {
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        reject(
          new SubagentAdmissionError({
            reason: "aborted",
            message: "Subagent admission aborted.",
          }),
        );
      };
      if (request.signal) {
        request.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () => request.signal?.removeEventListener("abort", onAbort);
        if (request.signal.aborted) {
          onAbort();
          return;
        }
      }
      this.pending.push(pending);
      this.drain();
    });
  }

  usage(prefix?: string): UsageStats {
    if (!prefix) return cloneUsage(this.totalUsage);
    return [...this.usageByRun.entries()].reduce(
      (total, [runId, usage]) => (runId.startsWith(prefix) ? addUsage(total, usage) : total),
      zeroUsage(),
    );
  }

  retainChild(child: ChildTypes.NativeChildSession, retention?: { scopeId: string; maxRetained: number }): void {
    if (this.closed) throw new Error("Subagent supervisor is shutting down.");
    this.children.delete(child.id);
    this.children.set(child.id, child);
    if (retention) this.childRetention.set(child.id, retention);
    else this.childRetention.delete(child.id);
  }

  pruneChildren(): void {
    if (this.closed) return;
    let excess = this.children.size - this.evicting.size - this.config.maxRetainedJobs;
    const counts = new Map<string, number>();
    for (const [id, retention] of this.childRetention) if (this.children.has(id) && !this.evicting.has(id)) counts.set(retention.scopeId, (counts.get(retention.scopeId) ?? 0) + 1);
    for (const child of this.children.values()) {
      if (!this.canEvict(child, excess, counts)) continue;
      const retention = this.childRetention.get(child.id);
      excess--;
      if (retention) counts.set(retention.scopeId, (counts.get(retention.scopeId) ?? 1) - 1);
      this.evicting.add(child.id);
      void child.close().then(
        () => { this.forgetClosedChild(child); this.evicting.delete(child.id); },
        (cause) => {
          if (this.evictionFailures.length < this.config.maxRetainedJobs) {
            this.evictionFailures.push(new Error(`Child ${child.id} eviction cleanup failed.`, { cause }));
          } else this.omittedEvictionFailures++;
          if (child.summary().state === ChildTypes.NativeChildState.Closed) this.forgetClosedChild(child);
          this.evicting.delete(child.id);
        },
      );
    }
  }

  private forgetClosedChild(child: ChildTypes.NativeChildSession): void {
    // A historical reopen can retain a new owner with the same native session ID.
    if (this.children.get(child.id) !== child) return;
    this.children.delete(child.id);
    this.childRetention.delete(child.id);
  }

  private canEvict(child: ChildTypes.NativeChildSession, globalExcess: number, counts: ReadonlyMap<string, number>): boolean {
    const retention = this.childRetention.get(child.id);
    const scopeExcess = retention ? (counts.get(retention.scopeId) ?? 0) > retention.maxRetained : false;
    const state = child.summary().state;
    const settled = state === ChildTypes.NativeChildState.Idle || state === ChildTypes.NativeChildState.Closed;
    return (globalExcess > 0 || scopeExcess) && settled && !this.evicting.has(child.id);
  }

  shutdown(): Promise<void> {
    return this.shutdownPromise ??= this.shutdownOwnedRuns();
  }

  private async shutdownOwnedRuns(): Promise<void> {
    this.closed = true;
    const error = new SubagentAdmissionError({
      reason: "closed",
      message: "Parent subagent session is shutting down.",
    });
    for (const pending of this.pending.splice(0)) {
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    for (const active of this.active.values()) active.controller.abort(error);
    const activeRuns = [...this.active.entries()];
    const closingChildren = Promise.allSettled([...this.children.values()].map((child) => child.close()));
    // Abort requests do not prove that tools or remote effects have settled.
    await Promise.all(activeRuns.map(([, active]) => active.done));
    const outcomes = await closingChildren;
    this.children.clear();
    this.childRetention.clear();
    const failures = [
      ...this.evictionFailures,
      ...outcomes.filter((outcome) => outcome.status === "rejected").map((failure) => failure.reason),
    ];
    if (failures.length) {
      const omitted = this.omittedEvictionFailures > 0 ? ` ${this.omittedEvictionFailures} additional eviction failure causes omitted.` : "";
      throw new AggregateError(failures, `Child shutdown failed.${omitted}`);
    }
  }

  private rejection(request: SubagentAdmissionRequest): SubagentAdmissionError | undefined {
    if (this.closed) {
      return new SubagentAdmissionError({
        reason: "closed",
        message: "Parent subagent session is not active.",
      });
    }
    if (request.signal?.aborted) {
      return new SubagentAdmissionError({
        reason: "aborted",
        message: "Subagent admission aborted.",
      });
    }
    const scoped = request.scopeId === undefined ? undefined : [
      ...[...this.active.values()].map((run) => run.request),
      ...this.pending.map((run) => run.request),
    ].filter((run) => run.scopeId === request.scopeId);
    const limits = request.limits ?? this.config;
    if (
      this.active.size + this.pending.length >= this.config.maxPendingRuns + this.config.maxConcurrentRuns ||
      (scoped !== undefined && scoped.length >= limits.maxPendingRuns + limits.maxConcurrentRuns)
    ) {
      return new SubagentAdmissionError({
        reason: "capacity",
        message: "Subagent run capacity is full.",
      });
    }
    return undefined;
  }

  private canStart(pending: PendingAdmission): boolean {
    if (this.active.size >= this.config.maxConcurrentRuns) return false;
    if (pending.request.scopeId !== undefined && [...this.active.values()].filter((run) => run.request.scopeId === pending.request.scopeId).length >= (pending.request.limits ?? this.config).maxConcurrentRuns) return false;
    return (
      pending.request.workspaceAccess !== WorkspaceAccess.Write ||
      !this.activeWorkspaceWriters.has(pending.request.cwd)
    );
  }

  private drain(): void {
    if (this.closed) return;
    while (this.active.size < this.config.maxConcurrentRuns) {
      const index = this.pending.findIndex((pending) => this.canStart(pending));
      if (index < 0) return;
      const [pending] = this.pending.splice(index, 1);
      pending.cleanupAbort?.();
      if (pending.request.signal?.aborted) {
        pending.reject(
          new SubagentAdmissionError({
            reason: "aborted",
            message: "Subagent admission aborted.",
          }),
        );
        continue;
      }
      pending.resolve(this.start(pending.runId, pending.request));
    }
  }

  private start(runId: string, request: SubagentAdmissionRequest): SubagentRunLease {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveRun = {
      request,
      controller,
      done,
      finish,
      usage: zeroUsage(),
      released: false,
    };
    active.timeout = setTimeout(
      () => controller.abort(new Error("Subagent run deadline exceeded.")),
      (request.limits ?? this.config).maxRunMs,
    );
    this.active.set(runId, active);
    if (request.workspaceAccess === WorkspaceAccess.Write) {
      this.activeWorkspaceWriters.add(request.cwd);
    }

    return {
      runId,
      signal,
      updateUsage: (usage) => this.updateUsage(runId, usage),
      release: (usage) => this.release(runId, usage),
    };
  }

  private updateUsage(runId: string, usage: UsageStats): void {
    const active = this.active.get(runId);
    if (!active || active.released) return;
    addUsageDelta(this.totalUsage, active.usage, usage);
    active.usage = cloneUsage(usage);
    this.usageByRun.set(runId, cloneUsage(usage));
  }

  private release(runId: string, usage?: UsageStats): void {
    const active = this.active.get(runId);
    if (!active || active.released) return;
    if (usage) this.updateUsage(runId, usage);
    active.released = true;
    if (active.timeout) clearTimeout(active.timeout);
    this.active.delete(runId);
    if (active.request.workspaceAccess === WorkspaceAccess.Write) {
      this.activeWorkspaceWriters.delete(active.request.cwd);
    }
    active.finish();
    if (!this.closed) this.pruneChildren();
    this.drain();
  }
}
