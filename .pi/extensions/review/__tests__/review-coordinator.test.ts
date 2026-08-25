import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  lookupRegisteredDagExecutor,
  resetDagExecutorRegistrationsForTests,
} from "../../_shared/dag-executor-registration";
import type { ReviewState } from "../core";
import { ReviewEvidenceExecutorKind, ReviewEvidenceResolverKey } from "../evidence-resolver";
import { ReviewCoordinator } from "../review-coordinator";

afterEach(() => resetDagExecutorRegistrationsForTests());

function context(sessionId: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => `/tmp/${sessionId}`,
    },
  } as ExtensionContext;
}

function state(id: string): ReviewState {
  return {
    snapshot: { id },
    selectedFindingIds: [],
    posts: [],
  } as unknown as ReviewState;
}

describe("ReviewCoordinator", () => {
  it("retains state for repeated activation of one session and isolates a new session", () => {
    const coordinator = new ReviewCoordinator();
    const first = context("first");

    coordinator.activate(first);
    const firstScope = coordinator.captureScope();
    coordinator.remember(state("review-1"));
    coordinator.beginPreparation("review-1");
    coordinator.activate(first);

    expect(coordinator.latestState()?.snapshot.id).toBe("review-1");
    expect(coordinator.isPreparing("review-1")).toBe(true);

    coordinator.activate(context("second"));

    expect(coordinator.activeContext?.sessionManager.getSessionId()).toBe("second");
    expect(coordinator.latestState()).toBeUndefined();
    expect(coordinator.reviews()).toHaveLength(0);
    expect(coordinator.isPreparing("review-1")).toBe(false);
    expect(coordinator.remember(state("stale-review"), firstScope)).toBe(false);
    expect(coordinator.review("stale-review")).toBeUndefined();
  });

  it("rejects a write from an operation that completes after a session switch", async () => {
    const coordinator = new ReviewCoordinator();
    coordinator.activate(context("first"));
    const scope = coordinator.captureScope();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => coordinator.remember(state("late"), scope));

    coordinator.activate(context("second"));
    finish();

    expect(await operation).toBe(false);
    expect(coordinator.review("late")).toBeUndefined();
  });

  it("owns evidence executor registration for the active runtime generation", () => {
    const coordinator = new ReviewCoordinator();
    coordinator.activate(context("session"));
    coordinator.setDagRegistration({
      registrationId: "registration",
      parentSessionId: "session",
      sessionGeneration: "generation",
      service: {},
    } as any);

    expect(
      lookupRegisteredDagExecutor(
        "session",
        "generation",
        ReviewEvidenceExecutorKind,
        ReviewEvidenceResolverKey,
      ),
    ).toBeTypeOf("function");

    coordinator.clearDagRegistration("registration");

    expect(
      lookupRegisteredDagExecutor(
        "session",
        "generation",
        ReviewEvidenceExecutorKind,
        ReviewEvidenceResolverKey,
      ),
    ).toBeUndefined();
  });

  it("deactivate and reset clear all workflow ownership", () => {
    const coordinator = new ReviewCoordinator();
    coordinator.activate(context("session"));
    coordinator.remember(state("review"));
    coordinator.beginPreparation("review");
    expect(coordinator.beginReconciliation("run")).toBe(true);
    const operation = Promise.resolve({ content: [], details: {} });
    coordinator.trackCreateOperation("create", operation);
    const semaphore = coordinator.postSemaphore;

    coordinator.deactivate();

    expect(coordinator.activeContext).toBeUndefined();
    expect(coordinator.dagRegistration).toBeUndefined();
    expect(coordinator.latestState()).toBeUndefined();
    expect(coordinator.reviews()).toHaveLength(0);
    expect(coordinator.isPreparing("review")).toBe(false);
    expect(coordinator.beginReconciliation("run")).toBe(true);
    expect(coordinator.createOperation("create")).toBeUndefined();
    expect(coordinator.postSemaphore).not.toBe(semaphore);
  });
});
