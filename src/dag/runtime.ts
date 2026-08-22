import { Effect, Layer } from "effect";
import type * as DagKernel from "./kernel.js";
import * as RuntimeCoordinator from "./internal/runtime-coordinator.js";
import * as RuntimeContracts from "./runtime-contracts.js";
import type * as DagValidation from "./validation.js";

export * from "./runtime-contracts.js";

export const DagRuntimeLive: Layer.Layer<RuntimeContracts.DagRuntimeService> = Layer.succeed(RuntimeContracts.DagRuntimeService, {
  submit: RuntimeCoordinator.submitDagRunInternal,
});

export const submitDagRun = <TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  initialState?: DagKernel.DagRunState<unknown, RuntimeContracts.DagFailedNodePayload>,
) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContracts.DagRuntimeService;
    return yield* runtime.submit(graph, initialState);
  });
