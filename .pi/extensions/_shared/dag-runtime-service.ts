import { randomUUID } from "node:crypto";
import type { Effect } from "effect";
import type {
  DagRunHandle,
  DagRuntimeError,
  DagSessionFailure,
  DagSessionReconstruction,
  ValidatedDagDefinition,
} from "../../../src/dag/index.js";
import { createRememberedRegistrationChannel } from "./remembered-registration-channel";

export const DagRuntimeServiceEvent = {
  Register: "dag-runtime-service:register",
  Unregister: "dag-runtime-service:unregister",
} as const;
export type DagRuntimeServiceEvent =
  (typeof DagRuntimeServiceEvent)[keyof typeof DagRuntimeServiceEvent];

export interface ActiveDagRuntimeService {
  readonly submit: <TPayload>(
    graph: ValidatedDagDefinition<TPayload>,
  ) => Effect.Effect<DagRunHandle, DagRuntimeError>;
  readonly reconstruct: (
    runId: string,
  ) => Effect.Effect<DagSessionReconstruction, DagSessionFailure>;
}

export interface DagRuntimeServiceRegistration {
  readonly parentSessionId: string;
  readonly sessionGeneration: string;
  readonly service: ActiveDagRuntimeService;
  readonly registrationId: string;
}

interface DagRuntimeServiceEventBus {
  emit(event: DagRuntimeServiceEvent, data: DagRuntimeServiceRegistration): void;
  on?(event: DagRuntimeServiceEvent, handler: (data: unknown) => void): void | (() => void);
}

export interface DagRuntimeServiceEvents {
  readonly events: DagRuntimeServiceEventBus;
}

const channel = createRememberedRegistrationChannel<
  DagRuntimeServiceRegistration,
  DagRuntimeServiceEvent
>({
  storeKey: "__piEnvDagRuntimeServiceRegistry",
  registerEvent: DagRuntimeServiceEvent.Register,
  unregisterEvent: DagRuntimeServiceEvent.Unregister,
  keyOf: () => "active",
  isDuplicate: (previous, next) => previous === next,
});

export function registerDagRuntimeService(
  events: DagRuntimeServiceEvents,
  registration: Omit<DagRuntimeServiceRegistration, "registrationId">,
): DagRuntimeServiceRegistration {
  const active = Object.freeze({ ...registration, registrationId: randomUUID() });
  channel.publish(events.events, active);
  return active;
}

export function unregisterDagRuntimeService(
  events: DagRuntimeServiceEvents,
  registration: DagRuntimeServiceRegistration,
): void {
  channel.unpublish(events.events, registration);
}

export function listenForDagRuntimeService(
  events: DagRuntimeServiceEvents,
  handler: (registration: DagRuntimeServiceRegistration) => void,
  removalHandler?: (registration: DagRuntimeServiceRegistration) => void,
): () => void {
  return channel.subscribe(events.events, handler, removalHandler);
}

export function resetDagRuntimeServiceRegistryForTests(): void {
  channel.reset();
}
