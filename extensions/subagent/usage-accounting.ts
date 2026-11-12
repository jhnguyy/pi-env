import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Result, Schema } from "effect";
import type { UsageStats } from "./types";
import { addUsage, cloneUsage, zeroUsage } from "./usage";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

const UsageStatsSchema = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cost: Schema.Finite,
  turns: Schema.Finite,
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

export interface UnavailableChildUsage {
  childSessionId?: string;
  name: string;
  sessionFile?: string;
  reason: string;
}

export interface SubagentUsageSummary {
  parent: UsageStats;
  children: UsageStats;
  total: UsageStats;
  childCount: number;
  unavailableChildren: UnavailableChildUsage[];
}

export const CHILD_USAGE_ENTRY_TYPE = "subagent.child-usage";

/** Mirrors native getSessionStats over raw history, not compacted/active context.
 * Pi 1.5.1 exports no standalone accounting helper. Only assistant messages are turns;
 * tool results (including legacy delegated costs) and summary operations are also billed.
 */
export function usageFromEntries(entries: readonly SessionEntry[]): UsageStats {
  const total = zeroUsage();
  const include = (usage: Usage | undefined) => {
    if (!usage) return;
    addUsage(total, { ...usage, cost: usage.cost.total });
  };
  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        total.turns++;
        include(entry.message.usage);
      } else if (entry.message.role === "toolResult") include(entry.message.usage);
    } else if (
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
    )
      include(entry.usage);
  }
  return total;
}

function recoverUsage(checkpoint: ChildUsageCheckpoint, parentFile: string): UsageStats {
  if (!checkpoint.sessionFile) throw new Error("No saved child session reference");
  // Opening a native manager can repair or migrate its file. Parse without a writer.
  const content = readFileSync(checkpoint.sessionFile, "utf8");
  const entries = parseSessionEntries(content);
  const header = entries[0];
  if (
    header?.type !== "session" ||
    header.version !== CURRENT_SESSION_VERSION ||
    header.id !== checkpoint.childSessionId ||
    !header.parentSession ||
    resolve(header.parentSession) !== resolve(parentFile)
  ) {
    throw new Error("Child session identity or parent reference mismatch");
  }
  if (entries.length !== content.split("\n").filter((line) => line.trim()).length) {
    throw new Error("Malformed child history");
  }
  const usage = usageFromEntries(entries.filter((entry) => entry.type !== "session"));
  if (
    Object.keys(checkpoint.usage).some(
      (key) => usage[key as keyof UsageStats] < checkpoint.usage[key as keyof UsageStats],
    )
  ) {
    throw new Error("Saved child usage is behind its last known checkpoint");
  }
  return usage;
}

/** Compact child projections live only in the parent's native custom entries.
 * Child transcripts remain the financial source of truth; no child runtime is created.
 */
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
        let usage: UsageStats;
        try {
          usage = recoverUsage(checkpoint, parentFile);
        } catch (error) {
          this.unavailable.set(checkpoint.childSessionId, {
            childSessionId: checkpoint.childSessionId,
            name: checkpoint.name,
            sessionFile: checkpoint.sessionFile,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        this.save({ ...checkpoint, usage });
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
