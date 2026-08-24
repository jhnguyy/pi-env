import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReviewDeckLimitError,
  buildReviewDeck,
  updateReviewDeckLaterRefs,
  type DeckReference,
} from "../deck";
import type { ReviewSnapshot } from "../schema";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSnapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  const root = mkdtempSync(join(tmpdir(), "pi-pr-review-deck-"));
  temps.push(root);
  const artifactDir = join(root, "artifacts");
  const worktree = join(root, "worktree");
  const diffPath = join(artifactDir, "diff.patch");
  mkdirSync(artifactDir, { recursive: true });
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,1 +1,2 @@",
    "+tokenCheck()",
    "diff --git a/test/auth.test.ts b/test/auth.test.ts",
    "--- a/test/auth.test.ts",
    "+++ b/test/auth.test.ts",
    "@@ -1,1 +1,2 @@",
    "+it('works')",
    "",
  ].join("\n");
  writeFileSync(diffPath, diff);
  return {
    id: "snapshot-a",
    artifactDir,
    worktree,
    diffPath,
    diffHash: "diff-hash",
    createdAt: "2024-01-01T00:00:00.000Z",
    metadata: {
      owner: "acme",
      repo: "widgets",
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      baseOid: "baseoid",
      headOid: "headoid",
      title: "Fix auth bug",
      body: "Adds tests for token validation",
      changedFiles: [
        { path: "src/auth.ts", added: 1, deleted: 0 },
        { path: "test/auth.test.ts", added: 1, deleted: 0 },
      ],
    },
    ...overrides,
  };
}

function makeLargeSnapshot(): ReviewSnapshot {
  const root = mkdtempSync(join(tmpdir(), "pi-pr-review-deck-large-"));
  temps.push(root);
  const artifactDir = join(root, "artifacts");
  const worktree = join(root, "worktree");
  const diffPath = join(artifactDir, "diff.patch");
  mkdirSync(artifactDir, { recursive: true });
  const changedFiles = Array.from({ length: 50 }, (_, index) => ({
    path: `src/features/feature-${index.toString().padStart(2, "0")}.ts`,
    added: 200 + index,
    deleted: 120 + index,
  }));
  const chunk = "x".repeat(4207);
  const parts: string[] = [];
  for (const file of changedFiles) {
    parts.push(
      `diff --git a/${file.path} b/${file.path}`,
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      `@@ -1,1 +1,321 @@`,
      `+${chunk}`,
    );
  }
  const diff = `${parts.join("\n")}PAD\n`;
  writeFileSync(diffPath, diff);
  expect(Buffer.byteLength(diff, "utf8")).toBe(218103);
  return {
    id: "snapshot-large",
    artifactDir,
    worktree,
    diffPath,
    diffHash: "diff-hash-large",
    createdAt: "2024-01-01T00:00:00.000Z",
    metadata: {
      owner: "acme",
      repo: "widgets",
      number: 70,
      url: "https://github.com/acme/widgets/pull/70",
      baseOid: "baseoid",
      headOid: "headoid-large",
      title: "Refactor feature set",
      body: "Updates implementation and tests",
      changedFiles,
    },
  };
}

describe("pr-review deck", () => {
  it("builds reproducibly apart from stable snapshot identity", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ id: "snapshot-b" });
    const refs: DeckReference[] = [{ kind: "review-guidance", id: "g1", uri: "guide://1" }];
    const first = buildReviewDeck({
      snapshot: a,
      reviewGuidanceRefs: refs,
      sourceRangeRefs: [
        { kind: "source-range", id: "s1", path: "src/auth.ts", startLine: 1, endLine: 9 },
      ],
      testRangeRefs: [
        { kind: "test-range", id: "t1", path: "test/auth.test.ts", startLine: 1, endLine: 8 },
      ],
      outOfDiffContractRefs: [{ kind: "out-of-diff-contract", id: "c1", uri: "contract://auth" }],
      priorFindingRefs: [{ kind: "prior-finding", id: "p1", uri: "finding://1" }],
      omissions: [{ type: "explicit-omission", detail: "No runtime logs attached." }],
    });
    const second = buildReviewDeck({
      snapshot: b,
      reviewGuidanceRefs: refs,
      sourceRangeRefs: [
        { kind: "source-range", id: "s1", path: "src/auth.ts", startLine: 1, endLine: 9 },
      ],
      testRangeRefs: [
        { kind: "test-range", id: "t1", path: "test/auth.test.ts", startLine: 1, endLine: 8 },
      ],
      outOfDiffContractRefs: [{ kind: "out-of-diff-contract", id: "c1", uri: "contract://auth" }],
      priorFindingRefs: [{ kind: "prior-finding", id: "p1", uri: "finding://1" }],
      omissions: [{ type: "explicit-omission", detail: "No runtime logs attached." }],
    });
    const normalize = (deck: typeof first.deck, snapshot: ReviewSnapshot) =>
      JSON.parse(
        JSON.stringify({ ...deck, snapshotId: "stable" }).replaceAll(
          snapshot.artifactDir,
          "<artifact-dir>",
        ),
      );
    expect(normalize(first.deck, a)).toEqual(normalize(second.deck, b));
    expect(first.deck.intent.inferred).toEqual(["bugfix", "security", "tests"]);
    expect(first.deck.risk.level).toBe("medium");
    expect(first.deck.files.map((file) => file.path)).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
  });

  it("never embeds raw diff or source content in deck json", () => {
    const snapshot = makeSnapshot();
    const built = buildReviewDeck({
      snapshot,
      sourceRangeRefs: [
        { kind: "source-range", id: "src", path: "src/auth.ts", startLine: 1, endLine: 4 },
      ],
    });
    const raw = readFileSync(built.path, "utf8");
    expect(raw).not.toContain("diff --git");
    expect(raw).not.toContain("@@ -");
    expect(raw).not.toContain("tokenCheck()");
  });

  it("does not reject patch-like text in untrusted reference metadata", () => {
    const snapshot = makeSnapshot();
    snapshot.metadata.title = "Handle diff --git text safely";
    snapshot.metadata.body = "Document @@ - markers without embedding a patch.";
    const built = buildReviewDeck({ snapshot });
    expect(built.deck.intent.statement).toBe("Handle diff --git text safely");
    expect(readFileSync(built.path, "utf8")).not.toContain("tokenCheck()");
  });

  it("normalizes shared metadata, diff, and file rows compactly", () => {
    const snapshot = makeLargeSnapshot();
    const built = buildReviewDeck({
      snapshot,
      sourceRangeRefs: snapshot.metadata.changedFiles
        .filter((_file, index) => index % 2 === 0)
        .map((file, index) => ({
          kind: "source-range" as const,
          id: `src-${index}`,
          path: file.path,
          startLine: 10,
          endLine: 40,
        })),
      testRangeRefs: snapshot.metadata.changedFiles
        .filter((_file, index) => index % 2 === 1)
        .map((file, index) => ({
          kind: "test-range" as const,
          id: `test-${index}`,
          path: file.path,
          startLine: 3,
          endLine: 15,
        })),
      reviewGuidanceRefs: [{ kind: "review-guidance", id: "g1", uri: "guide://1" }],
      priorFindingRefs: [{ kind: "prior-finding", id: "p1", uri: "finding://1" }],
      outOfDiffContractRefs: [{ kind: "out-of-diff-contract", id: "c1", uri: "contract://1" }],
      omissions: [{ type: "explicit-omission", detail: "No logs." }],
    });
    expect(built.bytes).toBeLessThan(32768);
    expect(new Set(built.deck.files.map((file) => file.path)).size).toBe(50);
    expect(built.deck.files).toHaveLength(50);
    expect(built.deck.files[0]?.id).toBe("0");
    expect(built.deck.files[10]?.id).toBe("a");
    expect(built.deck.files[0]?.source).toEqual({ startLine: 10, endLine: 40 });
    expect(built.deck.files[1]?.test).toEqual({ startLine: 3, endLine: 15 });
    expect(
      built.deck.files.every((file) => Number(!!file.source) + Number(!!file.test) === 1),
    ).toBe(true);
    expect(built.deck.metadataArtifactRef.id).toBe("m");
    expect(built.deck.pinnedDiffRef.id).toBe("d");
    expect(built.deck.pinnedDiffRef.diffHash).toBe("diff-hash-large");
    const raw = readFileSync(built.path, "utf8");
    expect(raw.match(/"diffHash": "diff-hash-large"/g)?.length ?? 0).toBe(1);
    expect(raw).not.toContain("x".repeat(80));
    const updated = updateReviewDeckLaterRefs({
      snapshot,
      readingPlanRefs: [{ kind: "reading-plan", id: "rp1", uri: "plan://1", value: "small" }],
      rawResultRefs: Array.from({ length: 6 }, (_, index) => ({
        kind: "raw-result" as const,
        id: `rr${index + 1}`,
        uri: `result://${index + 1}`,
      })),
    });
    expect(updated.bytes).toBeLessThan(32768);
    expect(
      readFileSync(updated.path, "utf8").match(/"diffHash": "diff-hash-large"/g)?.length ?? 0,
    ).toBe(1);
  });

  it("rejects source/test refs for unchanged paths", () => {
    const snapshot = makeSnapshot();
    expect(() =>
      buildReviewDeck({
        snapshot,
        sourceRangeRefs: [
          { kind: "source-range", id: "bad", path: "src/other.ts", startLine: 1, endLine: 2 },
        ],
      }),
    ).toThrow(/unchanged path/i);
  });

  it("fails closed on absolute bounds", () => {
    const base = makeSnapshot();
    const snapshot = makeSnapshot({
      metadata: {
        ...base.metadata,
        changedFiles: Array.from({ length: 513 }, (_, index) => ({ path: `src/file-${index}.ts` })),
      },
    });
    expect(() => buildReviewDeck({ snapshot })).toThrow(ReviewDeckLimitError);
    expect(() =>
      buildReviewDeck({
        snapshot: base,
        reviewGuidanceRefs: [
          { kind: "review-guidance", id: "oversized", note: "x".repeat(40_000) },
        ],
      }),
    ).toThrow(/reserved byte limit/i);
  });

  it("updates only later reading-plan/raw-result slots", () => {
    const snapshot = makeSnapshot();
    const initial = buildReviewDeck({
      snapshot,
      reviewGuidanceRefs: [{ kind: "review-guidance", id: "g1", uri: "guide://1" }],
    });
    chmodSync(initial.path, 0o600);
    const updated = updateReviewDeckLaterRefs({
      snapshot,
      readingPlanRefs: [{ kind: "reading-plan", id: "rp1", uri: "plan://1", value: "small" }],
      rawResultRefs: [{ kind: "raw-result", id: "rr1", uri: "result://1" }],
    });
    expect(updated.deck.reviewGuidanceRefs).toEqual(initial.deck.reviewGuidanceRefs);
    expect(updated.deck.laterRefs.readingPlanRefs).toEqual([
      { kind: "reading-plan", id: "rp1", uri: "plan://1", value: "small" },
    ]);
    expect(updated.deck.laterRefs.rawResultRefs).toEqual([
      { kind: "raw-result", id: "rr1", uri: "result://1" },
    ]);
    expect(statSync(updated.path).mode & 0o777).toBe(0o600);
    expect(() =>
      updateReviewDeckLaterRefs({
        snapshot,
        readingPlanRefs: [{ kind: "reading-plan", id: "rp2", value: "x".repeat(300) }],
      }),
    ).toThrow(/oversized reference value/i);
  });
});
