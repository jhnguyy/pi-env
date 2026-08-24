import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";

import type { SubagentRuntimeConfig } from "./config";
import type { UsageStats } from "./types";
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


interface SupervisorRegistry {
  supervisors: Map<string, SubagentRunSupervisor>;
}

const SUPERVISOR_REGISTRY_KEY = "__piEnvSubagentRunSupervisors";

function registry(): SupervisorRegistry {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  root[SUPERVISOR_REGISTRY_KEY] ??= { supervisors: new Map<string, SubagentRunSupervisor>() };
  return root[SUPERVISOR_REGISTRY_KEY] as SupervisorRegistry;
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
  private closed = false;

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

  async shutdown(): Promise<void> {
    if (this.closed) return;
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
    await Promise.race([
      Promise.allSettled(activeRuns.map(([, active]) => active.done)),
      new Promise<void>((resolve) => setTimeout(resolve, this.config.cancellationGraceMs)),
    ]);
    for (const [runId] of activeRuns) this.release(runId);
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
    if (
      this.active.size + this.pending.length >=
      this.config.maxPendingRuns + this.config.maxConcurrentRuns
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
      this.config.maxRunMs,
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
    this.drain();
  }
}

export function getSubagentRunSupervisor(sessionId: string): SubagentRunSupervisor | undefined {
  return registry().supervisors.get(sessionId);
}

export function getOrCreateSubagentRunSupervisor(
  sessionId: string,
  config: SubagentRuntimeConfig,
): SubagentRunSupervisor {
  const store = registry().supervisors;
  const current = store.get(sessionId);
  if (current) return current;
  const supervisor = new SubagentRunSupervisor(sessionId, config);
  store.set(sessionId, supervisor);
  return supervisor;
}

export async function disposeSubagentRunSupervisor(sessionId: string): Promise<void> {
  const store = registry().supervisors;
  const supervisor = store.get(sessionId);
  if (!supervisor) return;
  store.delete(sessionId);
  await supervisor.shutdown();
}

export function resetSubagentRunSupervisorsForTests(): void {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  delete root[SUPERVISOR_REGISTRY_KEY];
}
