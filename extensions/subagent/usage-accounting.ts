import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Data, Result, Schema } from "effect";
import type { SubagentUsageSummary, UnavailableChildUsage, UsageStats } from "./types";
import { addUsage, cloneUsage, zeroUsage } from "./usage";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

const TokenFields = {
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
};
const UsageStatsSchema = Schema.Struct({
  ...TokenFields,
  cost: Schema.Finite,
  turns: Schema.Finite,
});
const RecordedUsageSchema = Schema.Struct({
  ...TokenFields,
  cost: Schema.Struct({ total: Schema.Finite }),
});
// Only the financial projection is decoded; native conversation content stays opaque.
const AccountingEntrySchema = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      usage: Schema.optionalKey(RecordedUsageSchema),
    }),
  ),
  usage: Schema.optionalKey(RecordedUsageSchema),
});
const ChildUsageSnapshotSchema = Schema.Struct({
  childSessionId: Schema.String,
  name: Schema.String,
  sessionFile: Schema.optionalKey(Schema.String),
  usage: UsageStatsSchema,
});
export type ChildUsageSnapshot = typeof ChildUsageSnapshotSchema.Type;
const ChildUsageCheckpointSchema = Schema.Struct({
  ...ChildUsageSnapshotSchema.fields,
  version: Schema.Literal(1),
  parentSessionId: Schema.String,
});
export type ChildUsageCheckpoint = typeof ChildUsageCheckpointSchema.Type;

export const CHILD_USAGE_ENTRY_TYPE = "subagent.child-usage";

// Compacted context omits recorded spending. Pi 1.5.1 exposes no standalone totals helper.
export function usageFromEntries(
  entries: readonly (typeof AccountingEntrySchema.Type)[],
): UsageStats {
  const total = zeroUsage();
  const include = (usage: typeof RecordedUsageSchema.Type | undefined) => {
    if (!usage) return;
    addUsage(total, { ...usage, cost: usage.cost.total });
  };
  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.message?.role === "assistant") {
        total.turns++;
        include(entry.message.usage);
      } else if (entry.message?.role === "toolResult") include(entry.message.usage);
    } else if (
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
    )
      include(entry.usage);
  }
  return total;
}

class UsageRecoveryFailed extends Data.TaggedError("UsageRecoveryFailed")<{ reason: string }> {}

const recoveryFailed = (reason: string) => Result.fail(new UsageRecoveryFailed({ reason }));

function recoverUsage(
  checkpoint: ChildUsageCheckpoint,
  parentFile: string,
): Result.Result<UsageStats, UsageRecoveryFailed> {
  const sessionFile = checkpoint.sessionFile;
  if (!sessionFile) return recoveryFailed("No saved child session reference");
  // Opening a native manager can repair or migrate its file. Parse without a writer.
  const content = Result.try({
    try: () => readFileSync(sessionFile, "utf8"),
    catch: (cause) =>
      new UsageRecoveryFailed({
        reason: cause instanceof Error ? cause.message : "Cannot read saved child history",
      }),
  });
  if (Result.isFailure(content)) return Result.fail(content.failure);
  const entries = parseSessionEntries(content.success);
  const header = entries[0];
  if (
    header?.type !== "session" ||
    header.version !== CURRENT_SESSION_VERSION ||
    header.id !== checkpoint.childSessionId ||
    typeof header.parentSession !== "string" ||
    resolve(header.parentSession) !== resolve(parentFile)
  )
    return recoveryFailed("Child session identity or parent reference mismatch");
  if (entries.length !== content.success.split("\n").filter((line) => line.trim()).length) {
    return recoveryFailed("Malformed child history");
  }
  const financial = Schema.decodeUnknownResult(Schema.Array(AccountingEntrySchema))(entries);
  if (
    Result.isFailure(financial) ||
    financial.success.some(
      (entry) =>
        (entry.type === "message" &&
          (!entry.message || (entry.message.role === "assistant" && !entry.message.usage))) ||
        (entry.type === "usage" && !entry.usage),
    )
  )
    return recoveryFailed("Invalid recorded usage in child history");
  const usage = usageFromEntries(financial.success);
  if (
    Object.keys(checkpoint.usage).some(
      (key) => usage[key as keyof UsageStats] < checkpoint.usage[key as keyof UsageStats],
    )
  )
    return recoveryFailed("Saved child usage is behind its last known checkpoint");
  return Result.succeed(usage);
}

export class SubagentUsageAccounting {
  private parent?: ReadonlySessionManager;
  private generation = 0;
  private readonly children = new Map<string, ChildUsageCheckpoint>();
  private readonly unavailable = new Map<string, UnavailableChildUsage>();

  constructor(
    private readonly appendEntry: (customType: string, data: ChildUsageCheckpoint) => void,
  ) {}

  start(parent: ReadonlySessionManager): (snapshot: ChildUsageSnapshot) => void {
    this.generation++;
    this.parent = parent;
    this.children.clear();
    this.unavailable.clear();
    for (const entry of parent.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== CHILD_USAGE_ENTRY_TYPE) continue;
      const decoded = Schema.decodeUnknownResult(ChildUsageCheckpointSchema)(entry.data);
      if (Result.isFailure(decoded)) {
        this.unavailable.set(`invalid:${entry.id}`, {
          name: "Unknown child",
          reason: `Invalid child-usage checkpoint ${entry.id}`,
        });
        continue;
      }
      const checkpoint = decoded.success;
      this.children.set(checkpoint.childSessionId, {
        ...checkpoint,
        usage: cloneUsage(checkpoint.usage),
      });
    }
    const parentFile = parent.getSessionFile();
    if (parentFile) {
      for (const checkpoint of this.children.values()) {
        // Forks inherit a frozen projection, never a claim on the continuing child.
        if (checkpoint.parentSessionId !== parent.getSessionId()) continue;
        const recovered = recoverUsage(checkpoint, parentFile);
        if (Result.isFailure(recovered)) {
          this.unavailable.set(checkpoint.childSessionId, {
            childSessionId: checkpoint.childSessionId,
            name: checkpoint.name,
            sessionFile: checkpoint.sessionFile,
            reason: recovered.failure.reason,
          });
          continue;
        }
        this.save({ ...checkpoint, usage: recovered.success });
      }
    }
    return this.childReporter();
  }

  childReporter(): (snapshot: ChildUsageSnapshot) => void {
    const parent = this.parent;
    const parentSessionId = parent?.getSessionId();
    const generation = this.generation;
    return (snapshot) => {
      if (
        !parent ||
        !parentSessionId ||
        this.parent !== parent ||
        this.generation !== generation ||
        parent.getSessionId() !== parentSessionId
      )
        return;
      this.save({ ...snapshot, version: 1, parentSessionId });
      this.unavailable.delete(snapshot.childSessionId);
    };
  }

  summary(): SubagentUsageSummary {
    const parent = usageFromEntries(this.parent?.getEntries() ?? []);
    const children = zeroUsage();
    for (const snapshot of this.children.values()) addUsage(children, snapshot.usage);
    return {
      parent,
      children,
      total: addUsage(cloneUsage(parent), children),
      childCount: this.children.size,
      unavailableChildren: [...this.unavailable.values()].map((child) => ({ ...child })),
    };
  }

  private save(snapshot: ChildUsageCheckpoint): void {
    const checkpoint = { ...snapshot, usage: cloneUsage(snapshot.usage) };
    const previous = this.children.get(snapshot.childSessionId);
    if (
      previous &&
      previous.parentSessionId === checkpoint.parentSessionId &&
      previous.name === checkpoint.name &&
      previous.sessionFile === checkpoint.sessionFile &&
      Object.keys(checkpoint.usage).every(
        (key) =>
          previous.usage[key as keyof UsageStats] === checkpoint.usage[key as keyof UsageStats],
      )
    )
      return;
    // Persist first: a failed append must not make a retry appear already recorded.
    this.appendEntry(CHILD_USAGE_ENTRY_TYPE, {
      ...checkpoint,
      usage: cloneUsage(checkpoint.usage),
    });
    this.children.set(checkpoint.childSessionId, checkpoint);
  }
}
