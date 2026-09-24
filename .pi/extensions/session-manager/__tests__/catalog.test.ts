import { describe, expect, it } from "vitest";
import {
  ManifestMalformed,
  ManifestSemanticFailure,
  ManifestUnsupportedVersion,
  type ClosedSessionRecord,
  type OpenSessionRecord,
  type SessionManifest,
} from "../contracts.js";
import { canonicalJson, gcTombstones, validateManifest } from "../schema.js";

const cwd = "/tmp/workspace";
const createdAt = "2025-01-01T00:00:00.000Z";
const updatedAt = "2025-02-01T00:00:00.000Z";

function openRecord(overrides: Partial<OpenSessionRecord> = {}): OpenSessionRecord {
  return {
    version: 1,
    sessionId: "session-a",
    cwd,
    name: "amber-fox",
    persistence: { state: "pending" },
    createdAt,
    lastOpenedAt: createdAt,
    role: "work",
    desiredState: "open",
    ...overrides,
  };
}

function closedRecord(overrides: Partial<ClosedSessionRecord> = {}): ClosedSessionRecord {
  return {
    ...openRecord(),
    role: "work",
    desiredState: "closed",
    closedAt: createdAt,
    closedBy: "ctrl-d",
    ...overrides,
  };
}

function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    version: 1,
    canonicalCwd: cwd,
    revision: 0,
    updatedAt,
    sessions: [],
    ...overrides,
  };
}

describe("session manifest v1", () => {
  it("rejects unknown fields and unsupported versions without coercion", () => {
    expect(() => validateManifest({ ...manifest(), extra: true })).toThrow(ManifestMalformed);
    expect(() =>
      validateManifest({
        ...manifest(),
        sessions: [{ ...openRecord(), persistence: { state: "pending", extra: true } }],
      }),
    ).toThrow(ManifestMalformed);
    expect(() => validateManifest({ ...manifest(), version: 2 })).toThrow(
      ManifestUnsupportedVersion,
    );
  });

  it("enforces UTF-8 byte limits and path constraints", () => {
    expect(
      validateManifest(manifest({ sessions: [openRecord({ name: "é".repeat(64) })] })),
    ).toBeDefined();
    expect(() =>
      validateManifest(manifest({ sessions: [openRecord({ name: "é".repeat(65) })] })),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest(
        manifest({
          sessions: [
            openRecord({ persistence: { state: "materialized", sessionFile: "relative.jsonl" } }),
          ],
        }),
      ),
    ).toThrow(ManifestSemanticFailure);
  });

  it("rejects invalid explicit names without forbidding embedded spaces", () => {
    const { name: _name, ...unnamed } = openRecord();
    expect(() =>
      validateManifest(manifest({ sessions: [{ ...unnamed, explicitName: true }] })),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest(manifest({ sessions: [openRecord({ name: "\u2003" })] })),
    ).toThrow(ManifestSemanticFailure);
    expect(
      validateManifest(manifest({ sessions: [openRecord({ name: "quiet pine" })] })),
    ).toBeDefined();
  });

  it("rejects invalid identities, nested task references, and stale manifest timestamps", () => {
    expect(() =>
      validateManifest(manifest({ sessions: [openRecord({ sessionId: "bad\nidentity" })] })),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest(manifest({ sessions: [openRecord({ cwd: "/tmp/other" })] })),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest({
        ...manifest(),
        sessions: [
          {
            ...openRecord(),
            taskRef: { provider: "notes", reference: "task", extra: true },
          },
        ],
      }),
    ).toThrow(ManifestMalformed);
    expect(() =>
      validateManifest(
        manifest({
          updatedAt: "2024-12-31T23:59:59.999Z",
          sessions: [openRecord()],
        }),
      ),
    ).toThrow(ManifestSemanticFailure);
  });

  it("includes the coordinator in identity and exact active-name uniqueness", () => {
    const { desiredState: _desiredState, ...base } = openRecord({
      sessionId: "coordinator",
      name: "Fox",
    });
    const coordinator = { ...base, role: "coordinator" as const };
    const valid = {
      ...manifest(),
      coordinator,
      sessions: [openRecord({ sessionId: "work", name: "fox" })],
    };
    expect(validateManifest(valid).sessions).toHaveLength(1);
    expect(() =>
      validateManifest({
        ...valid,
        coordinator: {
          ...coordinator,
          taskRef: { provider: "notes", reference: "coordinator-task" },
        },
      }),
    ).toThrow(ManifestMalformed);
    expect(() =>
      validateManifest({
        ...valid,
        sessions: [openRecord({ sessionId: "coordinator", name: "other" })],
      }),
    ).toThrow(ManifestSemanticFailure);
  });

  it("enforces identity, active-name, timestamp, and stable-order invariants", () => {
    expect(() =>
      validateManifest(
        manifest({
          sessions: [openRecord(), openRecord({ sessionId: "session-b", name: "amber-fox" })],
        }),
      ),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest(
        manifest({
          sessions: [
            openRecord({ sessionId: "session-b", createdAt: "2025-01-02T00:00:00.000Z" }),
            openRecord({ sessionId: "session-a", name: "quiet-pine" }),
          ],
        }),
      ),
    ).toThrow(ManifestSemanticFailure);
    expect(() =>
      validateManifest(
        manifest({ sessions: [closedRecord({ closedAt: "2024-12-31T23:59:59.999Z" })] }),
      ),
    ).toThrow(ManifestSemanticFailure);
  });
});

describe("session manifest transforms", () => {
  it("serializes object keys deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it("garbage-collects only tombstones strictly older than 30 days", () => {
    const now = Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000;
    const exact = closedRecord({ sessionId: "exact", name: "exact", closedAt: createdAt });
    const older = closedRecord({
      sessionId: "older",
      name: "older",
      createdAt: "2024-12-31T23:59:59.999Z",
      lastOpenedAt: "2024-12-31T23:59:59.999Z",
      closedAt: "2024-12-31T23:59:59.999Z",
    });
    const source = manifest({ sessions: [older, exact, openRecord()] });

    const result = gcTombstones(source, now);

    expect(result.sessions.map((record) => record.sessionId)).toEqual(["exact", "session-a"]);
    expect(source.sessions).toHaveLength(3);
    expect(result).not.toBe(source);
  });
});
