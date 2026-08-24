import { randomUUID } from "node:crypto";
import type {
  DagEffectExecutor,
  DagExecutorKind,
} from "../../../src/dag/index.js";

export interface DagExecutorRegistration {
  readonly parentSessionId: string;
  readonly sessionGeneration: string;
  readonly kind: DagExecutorKind;
  readonly key: string;
  readonly executor: DagEffectExecutor;
  readonly registrationId: string;
}

type RegistryState = {
  readonly registrations: Map<string, DagExecutorRegistration>;
};

const StoreKey = "__piEnvDagExecutorRegistrations" as const;

function state(): RegistryState {
  const root = globalThis as typeof globalThis & { [StoreKey]?: RegistryState };
  root[StoreKey] ??= { registrations: new Map() };
  return root[StoreKey];
}

function registrationKey(input: {
  readonly parentSessionId: string;
  readonly sessionGeneration: string;
  readonly kind: DagExecutorKind;
  readonly key: string;
}): string {
  return JSON.stringify([
    input.parentSessionId,
    input.sessionGeneration,
    input.kind,
    input.key,
  ]);
}

export function registerDagExecutor(
  registration: Omit<DagExecutorRegistration, "registrationId">,
): DagExecutorRegistration {
  const key = registrationKey(registration);
  if (state().registrations.has(key))
    throw new Error(
      `DAG executor ${registration.kind}:${registration.key} is already registered for this session generation.`,
    );
  const active = Object.freeze({ ...registration, registrationId: randomUUID() });
  state().registrations.set(key, active);
  return active;
}

export function unregisterDagExecutor(registration: DagExecutorRegistration): void {
  const key = registrationKey(registration);
  if (state().registrations.get(key) === registration) state().registrations.delete(key);
}

export function removeDagExecutorsForSessionGeneration(
  parentSessionId: string,
  sessionGeneration: string,
): void {
  for (const [key, registration] of state().registrations) {
    if (
      registration.parentSessionId === parentSessionId &&
      registration.sessionGeneration === sessionGeneration
    )
      state().registrations.delete(key);
  }
}

export function lookupRegisteredDagExecutor(
  parentSessionId: string,
  sessionGeneration: string,
  kind: DagExecutorKind,
  key: string,
): DagEffectExecutor | undefined {
  return state().registrations.get(
    registrationKey({ parentSessionId, sessionGeneration, kind, key }),
  )?.executor;
}

export function resetDagExecutorRegistrationsForTests(): void {
  const root = globalThis as typeof globalThis & { [StoreKey]?: RegistryState };
  delete root[StoreKey];
}
