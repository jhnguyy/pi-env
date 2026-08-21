import { Effect, Layer } from "effect";
import type { DagRunState } from "./kernel.js";
import { submitDagRunInternal } from "./internal/runtime-coordinator.js";
import { DagRuntimeService, type DagFailedNodePayload } from "./runtime-contracts.js";
import type { ValidatedDagDefinition } from "./validation.js";

export * from "./runtime-contracts.js";

export const DagRuntimeLive: Layer.Layer<DagRuntimeService> = Layer.succeed(DagRuntimeService, {
  submit: submitDagRunInternal,
});

export const submitDagRun = <TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
  initialState?: DagRunState<unknown, DagFailedNodePayload>,
) =>
  Effect.gen(function* () {
    const runtime = yield* DagRuntimeService;
    return yield* runtime.submit(graph, initialState);
  });
