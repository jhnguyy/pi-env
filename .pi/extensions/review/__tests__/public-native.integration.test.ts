import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { git } from "./fixtures/review-repo";
import { createNativeReviewFixture } from "./fixtures/native-review";
import {
  ParentProvider,
  ReviewProvider,
  SecondReviewProvider,
  SignedOutProvider,
} from "./fixtures/native-review-provider";

const preferred = `${ReviewProvider}/faux-1`;
const secondary = `${SecondReviewProvider}/faux-1`;

it("honors authenticated scope order through native review, persistence, reuse, and reload", async (context) => {
  const review = createNativeReviewFixture(context, {
    scopedProviders: [SignedOutProvider, ReviewProvider, SecondReviewProvider, ReviewProvider],
    expected:
      "Two authenticated scoped models in scope order; complete coverage; accepted provenance; persistent reuse after reload",
  });
  await review.start();
  expect(review.availableModels()).toContain(`${ParentProvider}/faux-1`);
  expect(review.availableModels()).not.toContain(`${SignedOutProvider}/faux-1`);
  const result = await review.create();
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain(
    "Native review retained one actionable finding.",
  );
  expect(JSON.stringify(result.content)).toContain(
    "The exported value violates the requested contract.",
  );
  expect(JSON.stringify(result.content)).toContain("a.ts:1");
  const state = review.state();
  expect(state.dag?.status).toBe("succeeded");
  expect(state.result?.provenance?.status).toBe("accepted");
  expect(state.result?.coverage?.status).toBe("complete");
  expect(state.result?.findings).toHaveLength(1);
  expect(state.result?.findings[0]).toMatchObject({
    anchorValid: true,
    sourceReviewers: ["correctness"],
  });
  expect(state.roleAssignments).toMatchObject({
    "reading-plan": { model: preferred },
    correctness: { model: preferred },
    intent: { model: secondary },
    "whole-change": { model: secondary },
    synthesis: { model: secondary },
  });
  expect(git(state.snapshot.worktree, "rev-parse", "HEAD")).toBe(review.headOid);
  expect(state.snapshot.metadata.changedFiles).toEqual([{ path: "a.ts" }]);
  const persisted = await review.readPersistedState();
  expect(JSON.parse(persisted)).toEqual(state);
  const deck = JSON.parse(await readFile(state.deck!.path, "utf8"));
  expect(deck.laterRefs.readingPlanRefs).toHaveLength(1);
  expect(deck.laterRefs.rawResultRefs).toHaveLength(6);
  const children = await review.children();
  expect(children).toHaveLength(8);
  expect(new Set(children.map((child) => child.model))).toEqual(new Set([preferred, secondary]));
  for (const child of children) {
    expect(JSON.stringify(child.messages)).not.toContain("Parent-only marker.");
    const output = JSON.parse(child.initialResult!.finalOutput);
    if (output.goal) expect(child.model).toBe(preferred);
    if (output.role === "whole-change") expect(child.model).toBe(secondary);
    if (output.role) {
      expect(child.activeTools).toEqual([]);
      expect(child.callableTools).toEqual([]);
    }
  }
  expect(review.parentConfiguration()).toEqual({
    model: `${ParentProvider}/faux-1`,
    tools: ["review"],
  });
  expect(state.posts).toEqual([]);
  const reused = await review.create("Create the same fixture review again.");
  expect(reused).toMatchObject({ isError: false, details: { reused: true, status: "succeeded" } });
  expect(await review.children()).toHaveLength(8);
  expect(await review.readPersistedState()).toBe(persisted);
  await review.reload();
  const restored = await review.create("Open the existing fixture review after reload.");
  expect(restored).toMatchObject({
    isError: false,
    details: { reused: true, status: "succeeded" },
  });
  expect(JSON.stringify(restored.content)).toContain(
    "Native review retained one actionable finding.",
  );
  expect(JSON.stringify(restored.content)).toContain(
    "The exported value violates the requested contract.",
  );
  expect(review.state()).toEqual(state);
  expect(await review.children()).toHaveLength(8);
  expect(await review.readPersistedState()).toBe(persisted);
});

it("honors an eligible role pin in the native child model", async (context) => {
  const review = createNativeReviewFixture(context, {
    scopedProviders: [ReviewProvider, SecondReviewProvider],
    roleModels: { correctness: secondary },
    expected:
      "Correctness runs on the explicitly pinned secondary model; planner retains the first scoped model",
  });
  await review.start();
  const result = await review.create();
  expect(result.isError).not.toBe(true);
  expect(review.state().roleAssignments).toMatchObject({
    "reading-plan": { model: preferred, pinned: false },
    correctness: { model: secondary, pinned: true },
  });
  const child = (await review.children())
    .find((candidate) => JSON.parse(candidate.initialResult!.finalOutput).role === "correctness");
  expect(child?.model).toBe(secondary);
  expect(review.state().result?.coverage?.status).toBe("complete");
});

const rejections: {
  name: string;
  scopedProviders: readonly string[];
  roleModels: Record<string, string>;
  message: string;
}[] = [
  {
    name: "empty scope",
    scopedProviders: [],
    roleModels: {},
    message: "No authenticated scoped models",
  },
  {
    name: "signed-out-only scope",
    scopedProviders: [SignedOutProvider],
    roleModels: {},
    message: "No authenticated scoped models",
  },
  {
    name: "authenticated out-of-scope pin",
    scopedProviders: [ReviewProvider],
    roleModels: { correctness: `${ParentProvider}/faux-1` },
    message: "outside the authenticated scoped models",
  },
  {
    name: "signed-out pin",
    scopedProviders: [ReviewProvider, SignedOutProvider],
    roleModels: { correctness: `${SignedOutProvider}/faux-1` },
    message: "outside the authenticated scoped models",
  },
  {
    name: "unavailable pin",
    scopedProviders: [ReviewProvider],
    roleModels: { security: "missing/model" },
    message: "missing/model",
  },
  {
    name: "unknown role pin",
    scopedProviders: [ReviewProvider],
    roleModels: { invented: preferred },
    message: "Unknown PR review role pin",
  },
];
it.for(rejections)("rejects $name before review children start", async (input, context) => {
  const review = createNativeReviewFixture(context, {
    scopedProviders: input.scopedProviders,
    roleModels: input.roleModels,
    expected: `${input.message}; model-policy failure; no review children; worktree removed`,
  });
  await review.start();
  const result = await review.create();
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ stage: "model-policy", status: "failed" });
  expect(JSON.stringify(result.content)).toContain(input.message);
  const state = review.state();
  expect(state.dag).toBeUndefined();
  expect(state.roleAssignments).toBeUndefined();
  expect(state.preparation?.worktreeCleaned).toBe(true);
  expect(existsSync(state.snapshot.worktree)).toBe(false);
  expect(await review.children()).toHaveLength(0);
});

it("preserves a real planner provider error and failed-result reuse after reload", async (context) => {
  const review = createNativeReviewFixture(context, {
    scopedProviders: [ReviewProvider],
    provider: { plannerError: "Provider quota exhausted" },
    expected:
      "Planner provider error and real child transcript are preserved; eight nodes blocked; zero failed reviewers; reload does not rerun",
  });
  await review.start();
  const result = await review.create();
  expect(result.isError).toBe(true);
  const content = JSON.stringify(result.content);
  expect(content).toContain("reading-plan: Provider quota exhausted");
  expect(content).toContain("Review incomplete; no assessment produced.");
  expect(content).not.toContain("No findings.");
  expect(result.details).toMatchObject({
    failedNodes: ["reading-plan"],
    metrics: {
      reviewersSucceeded: 0,
      reviewersFailed: 0,
      reviewersMalformed: 0,
      reviewersBlocked: 6,
    },
  });
  const state = review.state();
  expect(state.dag?.blockedNodes).toHaveLength(8);
  expect(state.dag?.failure).toMatchObject({
    nodeId: "reading-plan",
    message: "Provider quota exhausted",
  });
  const sessionFile = state.dag?.failure?.sessionFile;
  if (!sessionFile) throw new Error("Missing planner transcript reference");
  expect(content).toContain(sessionFile);
  expect(await readFile(sessionFile, "utf8")).toContain("Provider quota exhausted");
  expect(await review.children()).toHaveLength(1);
  const persisted = await review.readPersistedState();
  await review.reload();
  const reused = await review.create("Open the failed fixture review after reload.");
  expect(reused).toMatchObject({ isError: true, details: { reused: true } });
  expect(JSON.stringify(reused.content)).toContain("Provider quota exhausted");
  expect(review.state()).toEqual(state);
  expect(await review.readPersistedState()).toBe(persisted);
  expect(await review.children()).toHaveLength(1);
});
