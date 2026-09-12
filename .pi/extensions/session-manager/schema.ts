import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  ManifestMalformed,
  ManifestSemanticFailure,
  ManifestUnsupportedVersion,
  type SessionManifest,
  type SessionRecord,
} from "./contracts.js";

const task = Schema.Struct({ provider: Schema.Literal("notes"), reference: Schema.String });
const pending = Schema.Struct({ state: Schema.Literal("pending") });
const materialized = Schema.Struct({
  state: Schema.Literal("materialized"),
  sessionFile: Schema.String,
});
const base = {
  version: Schema.Literal(1),
  sessionId: Schema.String,
  cwd: Schema.String,
  name: Schema.String,
  persistence: Schema.Union([pending, materialized]),
  createdAt: Schema.String,
  lastOpenedAt: Schema.String,
};
const coordinator = Schema.Struct({ ...base, role: Schema.Literal("coordinator") });
const workBase = { ...base, taskRef: Schema.optionalKey(task) };
const open = Schema.Struct({
  ...workBase,
  role: Schema.Literal("work"),
  desiredState: Schema.Literal("open"),
});
const closed = Schema.Struct({
  ...workBase,
  role: Schema.Literal("work"),
  desiredState: Schema.Literal("closed"),
  closedAt: Schema.String,
  closedBy: Schema.Literals(["ctrl-d", "session-done"]),
});
export const SessionManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  canonicalCwd: Schema.String,
  revision: Schema.Number,
  updatedAt: Schema.String,
  coordinator: Schema.optionalKey(coordinator),
  sessions: Schema.Array(Schema.Union([open, closed])),
});
const decode = Schema.decodeUnknownSync(SessionManifestSchema, { onExcessProperty: "error" });
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const timestamp = (value: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const semantic = (path: string, reason: string): never => {
  throw new ManifestSemanticFailure({ path, reason });
};

function decodeManifest(value: unknown, path: string): SessionManifest {
  if (typeof value === "object" && value !== null && "version" in value && value.version !== 1) {
    throw new ManifestUnsupportedVersion({ path, version: value.version });
  }
  try {
    return decode(value);
  } catch {
    throw new ManifestMalformed({ path, reason: "invalid strict v1 shape" });
  }
}

function validateMetadata(manifest: SessionManifest, path: string): void {
  if (!isAbsolute(manifest.canonicalCwd) || manifest.canonicalCwd.includes("\0")) {
    semantic(path, "invalid canonical cwd");
  }
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0) {
    semantic(path, "invalid revision");
  }
  if (!timestamp(manifest.updatedAt)) semantic(path, "invalid updated timestamp");
}

function validateRecordBase(record: SessionRecord, canonicalCwd: string, path: string): void {
  const validIdentity =
    bytes(record.sessionId) >= 1 &&
    bytes(record.sessionId) <= 256 &&
    !/[\0\r\n]/.test(record.sessionId);
  const validName =
    bytes(record.name) >= 1 && bytes(record.name) <= 128 && !/[\p{Cc}\p{Cf}]/u.test(record.name);
  const validTimes =
    timestamp(record.createdAt) &&
    timestamp(record.lastOpenedAt) &&
    record.createdAt <= record.lastOpenedAt;
  if (!validIdentity || record.cwd !== canonicalCwd || !validName || !validTimes) {
    semantic(path, "invalid record fields");
  }
}

function validateRecordDetails(record: SessionRecord, path: string): void {
  if (
    record.persistence.state === "materialized" &&
    (!isAbsolute(record.persistence.sessionFile) || record.persistence.sessionFile.includes("\0"))
  ) {
    semantic(path, "invalid session file");
  }
  if (
    record.role === "work" &&
    record.taskRef &&
    (bytes(record.taskRef.reference) < 1 || bytes(record.taskRef.reference) > 2048)
  ) {
    semantic(path, "invalid task reference");
  }
  if (
    record.role === "work" &&
    record.desiredState === "closed" &&
    (!timestamp(record.closedAt) ||
      record.closedAt < record.createdAt ||
      record.closedAt < record.lastOpenedAt)
  ) {
    semantic(path, "invalid closure");
  }
}

function addUniqueIdentity(
  record: SessionRecord,
  ids: Set<string>,
  activeNames: Set<string>,
  path: string,
): void {
  if (ids.has(record.sessionId)) semantic(path, "duplicate session id");
  ids.add(record.sessionId);
  if (record.role === "work" && record.desiredState !== "open") return;
  if (activeNames.has(record.name)) semantic(path, "duplicate active name");
  activeNames.add(record.name);
}

function validateUpdatedAt(record: SessionRecord, updatedAt: string, path: string): void {
  const latest =
    record.role === "work" && record.desiredState === "closed"
      ? record.closedAt
      : record.lastOpenedAt;
  if (updatedAt < latest) semantic(path, "updatedAt predates record");
}

function validateSessionOrder(
  previous: SessionManifest["sessions"][number] | undefined,
  current: SessionManifest["sessions"][number],
  path: string,
): void {
  if (!previous) return;
  const outOfOrder =
    current.createdAt < previous.createdAt ||
    (current.createdAt === previous.createdAt && current.sessionId < previous.sessionId);
  if (outOfOrder) semantic(path, "sessions not ordered");
}

/** Decodes every object strictly, then applies v1 domain invariants. */
export function validateManifest(value: unknown, path = "manifest"): SessionManifest {
  const manifest = decodeManifest(value, path);
  validateMetadata(manifest, path);
  const ids = new Set<string>();
  const activeNames = new Set<string>();
  if (manifest.coordinator) {
    validateRecordBase(manifest.coordinator, manifest.canonicalCwd, path);
    validateRecordDetails(manifest.coordinator, path);
    addUniqueIdentity(manifest.coordinator, ids, activeNames, path);
    validateUpdatedAt(manifest.coordinator, manifest.updatedAt, path);
  }
  let previous: SessionManifest["sessions"][number] | undefined;
  for (const record of manifest.sessions) {
    validateRecordBase(record, manifest.canonicalCwd, path);
    validateRecordDetails(record, path);
    addUniqueIdentity(record, ids, activeNames, path);
    validateSessionOrder(previous, record, path);
    validateUpdatedAt(record, manifest.updatedAt, path);
    previous = record;
  }
  return manifest;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function gcTombstones(manifest: SessionManifest, now: number): SessionManifest {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  return {
    ...manifest,
    sessions: manifest.sessions.filter(
      (record) => record.desiredState !== "closed" || Date.parse(record.closedAt) >= cutoff,
    ),
  };
}
