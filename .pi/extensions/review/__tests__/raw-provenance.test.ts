import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  MaxRawFindingArtifactBytes,
  persistRawFindingArtifacts,
  readRawFindingArtifact,
} from "../raw-provenance";
import type { AdmittedRawFinding, RawFindingRecord } from "../schema";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "raw-review-provenance-"));
  roots.push(root);
  const raw: AdmittedRawFinding = {
    id: `R-${"a".repeat(64)}`,
    role: "correctness",
    evidenceDigest: "b".repeat(64),
    finding: {
      severity: "serious",
      impact: "high",
      problem: "Original problem.",
      consequence: "Original consequence.",
      suggestedFix: "Original fix.",
    },
  };
  return { root, raw, runId: "review-run" };
}

async function persistFixture() {
  const f = fixture();
  const records = await Effect.runPromise(persistRawFindingArtifacts(f.root, f.runId, [f.raw]));
  return { ...f, record: records[0] };
}

function changed(
  record: RawFindingRecord,
  artifact: Partial<RawFindingRecord["artifact"]>,
): RawFindingRecord {
  return { ...record, artifact: { ...record.artifact, ...artifact } };
}

describe("bounded raw finding provenance artifacts", () => {
  it("stores payload-free state records and materializes one verified raw finding", async () => {
    const f = await persistFixture();
    expect(f.record).not.toHaveProperty("finding");
    expect(f.record.artifact.bytes).toBeLessThanOrEqual(MaxRawFindingArtifactBytes);
    await expect(
      Effect.runPromise(readRawFindingArtifact(f.root, f.runId, f.record)),
    ).resolves.toEqual(f.raw);
  });

  it("rejects wrong identity, declared size, digest, and public byte ceiling", async () => {
    const f = await persistFixture();
    const mutations = [
      changed(f.record, { runId: "other-run" }),
      changed(f.record, { bytes: f.record.artifact.bytes + 1 }),
      changed(f.record, { digest: "0".repeat(64) }),
      changed(f.record, { bytes: MaxRawFindingArtifactBytes + 1 }),
    ];
    for (const mutation of mutations) {
      await expect(
        Effect.runPromise(readRawFindingArtifact(f.root, f.runId, mutation)),
      ).rejects.toBeDefined();
    }
  });

  it("rejects traversal and symlinks even when a symlink remains inside storage", async () => {
    const f = await persistFixture();
    await expect(
      Effect.runPromise(
        readRawFindingArtifact(
          f.root,
          f.runId,
          changed(f.record, { path: `../${path.basename(f.record.artifact.path)}` }),
        ),
      ),
    ).rejects.toBeDefined();

    const artifactPath = path.join(f.root, f.record.artifact.path);
    const movedPath = path.join(path.dirname(artifactPath), "moved.json");
    renameSync(artifactPath, movedPath);
    symlinkSync("moved.json", artifactPath);
    await expect(
      Effect.runPromise(readRawFindingArtifact(f.root, f.runId, f.record)),
    ).rejects.toThrow(/symlink/i);
  });

  it("rejects a symlinked artifact root before public writes and leaves its target unchanged", async () => {
    const f = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "raw-review-root-target-"));
    roots.push(outside);
    rmSync(f.root, { recursive: true });
    symlinkSync(outside, f.root, "dir");

    await expect(
      Effect.runPromise(persistRawFindingArtifacts(f.root, f.runId, [f.raw])),
    ).rejects.toThrow(/root.*symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a symlinked artifact root before public reads", async () => {
    const f = await persistFixture();
    const alias = mkdtempSync(path.join(tmpdir(), "raw-review-root-link-"));
    roots.push(alias);
    rmSync(alias, { recursive: true });
    symlinkSync(f.root, alias, "dir");

    await expect(
      Effect.runPromise(readRawFindingArtifact(alias, f.runId, f.record)),
    ).rejects.toThrow(/root.*symlink/i);
  });

  it("does not overwrite a changed artifact when persistence is replayed", async () => {
    const f = await persistFixture();
    writeFileSync(path.join(f.root, f.record.artifact.path), "changed");
    await expect(
      Effect.runPromise(persistRawFindingArtifacts(f.root, f.runId, [f.raw])),
    ).rejects.toBeDefined();
  });

  it("rejects a symlinked artifact directory before writing", async () => {
    const f = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "raw-review-outside-"));
    roots.push(outside);
    mkdirSync(f.root, { recursive: true });
    symlinkSync(outside, path.join(f.root, "raw-provenance-v2"), "dir");
    await expect(
      Effect.runPromise(persistRawFindingArtifacts(f.root, f.runId, [f.raw])),
    ).rejects.toBeDefined();
    expect(readdirSync(outside)).toEqual([]);
  });
});
