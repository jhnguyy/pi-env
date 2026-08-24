import {
  DagSessionEntryType,
  type DagSessionEntry,
  type DagSessionStore,
} from "../../../src/dag/index.js";

export interface ParentSessionEntryStore {
  readonly getBranch: () => readonly unknown[];
  readonly appendCustomEntry: (customType: string, data?: unknown) => string;
}

function isDagSessionWrapper(
  entry: unknown,
): entry is { readonly data?: unknown } {
  if (typeof entry !== "object" || entry === null) return false;
  const wrapper = entry as { readonly type?: unknown; readonly customType?: unknown };
  return wrapper.type === "custom" && wrapper.customType === DagSessionEntryType;
}

export function makeDagSessionStore(manager: ParentSessionEntryStore): DagSessionStore {
  return Object.freeze({
    read: () => manager.getBranch().filter(isDagSessionWrapper).map((entry) => entry.data),
    append: (entry: DagSessionEntry) => {
      manager.appendCustomEntry(DagSessionEntryType, entry);
    },
  });
}

export function persistedDagRunIds(store: DagSessionStore): Set<string> {
  const runIds = new Set<string>();
  for (const entry of store.read()) {
    if (typeof entry !== "object" || entry === null) continue;
    const runId = (entry as { readonly runId?: unknown }).runId;
    if (typeof runId === "string") runIds.add(runId);
  }
  return runIds;
}
