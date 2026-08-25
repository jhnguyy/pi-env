import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PartitionedSemaphore } from "effect";
import {
  registerDagExecutor,
  unregisterDagExecutor,
  type DagExecutorRegistration,
} from "../_shared/dag-executor-registration";
import type { DagRuntimeServiceRegistration } from "../_shared/dag-runtime-service";
import type { ReviewState } from "./core";
import {
  makeReviewEvidenceResolverExecutor,
  ReviewEvidenceExecutorKind,
  ReviewEvidenceResolverKey,
} from "./evidence-resolver";

export interface ReviewCoordinatorScope {
  readonly sessionId: string;
  readonly generation: number;
}

export type ReviewActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
  usage?: Usage;
};

/** Session-scoped owner for the review extension's mutable workflow state. */
export class ReviewCoordinator {
  private readonly states = new Map<string, ReviewState>();
  private readonly createOperations = new Map<string, Promise<ReviewActionResult>>();
  private readonly preparingReviewIds = new Set<string>();
  private readonly reconcilingRunIds = new Set<string>();

  private postingSemaphore = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });
  private context: ExtensionContext | undefined;
  private runtimeRegistration: DagRuntimeServiceRegistration | undefined;
  private evidenceRegistration: DagExecutorRegistration | undefined;
  private selectedReviewId: string | undefined;
  private sessionId: string | undefined;
  private generation = 0;

  get activeContext(): ExtensionContext | undefined {
    return this.context;
  }

  get dagRegistration(): DagRuntimeServiceRegistration | undefined {
    return this.runtimeRegistration;
  }

  get latestReviewId(): string | undefined {
    return this.selectedReviewId;
  }

  get postSemaphore() {
    return this.postingSemaphore;
  }

  captureScope(): ReviewCoordinatorScope {
    if (!this.sessionId) throw new Error("The review coordinator has no active session.");
    return Object.freeze({ sessionId: this.sessionId, generation: this.generation });
  }

  isScopeActive(scope: ReviewCoordinatorScope): boolean {
    return scope.sessionId === this.sessionId && scope.generation === this.generation;
  }

  reviews(): readonly ReviewState[] {
    return [...this.states.values()];
  }

  review(reviewId: string): ReviewState | undefined {
    return this.states.get(reviewId);
  }

  reviewIds(): readonly string[] {
    return [...this.states.keys()];
  }

  findReview(predicate: (state: ReviewState) => boolean): ReviewState | undefined {
    for (const state of this.states.values()) if (predicate(state)) return state;
    return undefined;
  }

  isPreparing(reviewId: string): boolean {
    return this.preparingReviewIds.has(reviewId);
  }

  beginPreparation(reviewId: string): void {
    this.preparingReviewIds.add(reviewId);
  }

  finishPreparation(reviewId: string): void {
    this.preparingReviewIds.delete(reviewId);
  }

  beginReconciliation(runId: string): boolean {
    if (this.reconcilingRunIds.has(runId)) return false;
    this.reconcilingRunIds.add(runId);
    return true;
  }

  finishReconciliation(runId: string): void {
    this.reconcilingRunIds.delete(runId);
  }

  createOperation(identityKey: string): Promise<ReviewActionResult> | undefined {
    return this.createOperations.get(identityKey);
  }

  trackCreateOperation(identityKey: string, operation: Promise<ReviewActionResult>): void {
    this.createOperations.set(identityKey, operation);
  }

  finishCreateOperation(identityKey: string, operation: Promise<ReviewActionResult>): void {
    if (this.createOperations.get(identityKey) === operation)
      this.createOperations.delete(identityKey);
  }

  activate(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.sessionId !== undefined && this.sessionId !== sessionId) this.reset();
    this.context = ctx;
    this.sessionId = sessionId;
    if (this.runtimeRegistration && this.runtimeRegistration.parentSessionId !== sessionId)
      this.setDagRegistration(undefined);
    this.synchronizeEvidenceExecutor();
  }

  deactivate(): void {
    this.reset();
  }

  reset(): void {
    this.generation += 1;
    this.states.clear();
    this.createOperations.clear();
    this.preparingReviewIds.clear();
    this.reconcilingRunIds.clear();
    this.selectedReviewId = undefined;
    this.postingSemaphore = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });
    this.context = undefined;
    this.sessionId = undefined;
    this.runtimeRegistration = undefined;
    if (this.evidenceRegistration) unregisterDagExecutor(this.evidenceRegistration);
    this.evidenceRegistration = undefined;
  }

  setDagRegistration(registration: DagRuntimeServiceRegistration | undefined): void {
    this.runtimeRegistration = registration;
    this.synchronizeEvidenceExecutor();
  }

  clearDagRegistration(registrationId: string): boolean {
    if (this.runtimeRegistration?.registrationId !== registrationId) return false;
    this.setDagRegistration(undefined);
    return true;
  }

  resetReviews(): void {
    this.states.clear();
    this.selectedReviewId = undefined;
  }

  remember(state: ReviewState, scope?: ReviewCoordinatorScope): boolean {
    if (scope && !this.isScopeActive(scope)) return false;
    this.states.set(state.snapshot.id, structuredClone(state));
    this.selectedReviewId = state.snapshot.id;
    return true;
  }

  latestState(): ReviewState | undefined {
    return this.selectedReviewId ? this.states.get(this.selectedReviewId) : undefined;
  }

  select(reviewId: string): void {
    this.selectedReviewId = reviewId;
  }

  deleteReview(reviewId: string): void {
    this.states.delete(reviewId);
    if (this.selectedReviewId === reviewId) this.selectedReviewId = [...this.states.keys()].at(-1);
  }

  private synchronizeEvidenceExecutor(): void {
    const registration = this.runtimeRegistration;
    const ctx = this.context;
    if (
      this.evidenceRegistration &&
      (!registration ||
        this.evidenceRegistration.parentSessionId !== registration.parentSessionId ||
        this.evidenceRegistration.sessionGeneration !== registration.sessionGeneration)
    ) {
      unregisterDagExecutor(this.evidenceRegistration);
      this.evidenceRegistration = undefined;
    }
    if (
      this.evidenceRegistration ||
      !registration ||
      !ctx ||
      registration.parentSessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    this.evidenceRegistration = registerDagExecutor({
      parentSessionId: registration.parentSessionId,
      sessionGeneration: registration.sessionGeneration,
      kind: ReviewEvidenceExecutorKind,
      key: ReviewEvidenceResolverKey,
      executor: makeReviewEvidenceResolverExecutor({
        artifactRoot: join(
          ctx.sessionManager.getSessionDir(),
          "dag-artifacts",
          ctx.sessionManager.getSessionId(),
        ),
      }),
    });
  }
}
