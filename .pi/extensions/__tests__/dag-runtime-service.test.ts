import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DagRuntimeServiceEvent,
  listenForDagRuntimeService,
  registerDagRuntimeService,
  resetDagRuntimeServiceRegistryForTests,
  unregisterDagRuntimeService,
  type ActiveDagRuntimeService,
  type DagRuntimeServiceEvent as DagRuntimeServiceEventValue,
  type DagRuntimeServiceEvents,
  type DagRuntimeServiceRegistration,
} from "../_shared/dag-runtime-service";

function createEvents(): DagRuntimeServiceEvents {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    events: {
      emit(event: DagRuntimeServiceEventValue, data: DagRuntimeServiceRegistration) {
        for (const handler of handlers.get(event) ?? []) handler(data);
      },
      on(event: DagRuntimeServiceEventValue, handler: (data: unknown) => void) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
        return () => {
          const index = registered.indexOf(handler);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };
}

const service: ActiveDagRuntimeService = {
  submit: () => Effect.die("unused"),
  reconstruct: () => Effect.die("unused"),
};

describe("DAG runtime service registration", () => {
  beforeEach(() => {
    resetDagRuntimeServiceRegistryForTests();
  });

  it("replays the active generation and preserves its replacement against stale removal", () => {
    const events = createEvents();
    const first = registerDagRuntimeService(events, {
      parentSessionId: "parent-a",
      sessionGeneration: "generation-a",
      service,
    });

    const late: DagRuntimeServiceRegistration[] = [];
    const removed: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(
      events,
      (registration) => late.push(registration),
      (registration) => removed.push(registration),
    );
    expect(late).toEqual([first]);

    const replacement = registerDagRuntimeService(events, {
      parentSessionId: "parent-b",
      sessionGeneration: "generation-b",
      service,
    });
    unregisterDagRuntimeService(events, first);
    events.events.emit(DagRuntimeServiceEvent.Unregister, first);
    expect(removed).toEqual([]);

    const afterStaleRemoval: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(events, (registration) => afterStaleRemoval.push(registration));
    expect(afterStaleRemoval).toEqual([replacement]);
    expect(replacement.registrationId).not.toBe(first.registrationId);

    unregisterDagRuntimeService(events, replacement);
    expect(removed).toEqual([replacement]);
    events.events.emit(DagRuntimeServiceEvent.Unregister, replacement);
    expect(removed).toEqual([replacement]);
    const afterShutdown: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(events, (registration) => afterShutdown.push(registration));
    expect(afterShutdown).toEqual([]);
  });
});
