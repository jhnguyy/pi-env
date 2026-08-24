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

  it("rolls back remembered state when registration publication fails", () => {
    const events = createEvents();
    const throwingEvents: DagRuntimeServiceEvents = {
      events: {
        emit() {
          throw new Error("listener failed");
        },
      },
    };

    expect(() =>
      registerDagRuntimeService(throwingEvents, {
        parentSessionId: "failed",
        sessionGeneration: "failed",
        service,
      }),
    ).toThrow("listener failed");
    const afterInitialFailure: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(events, (registration) => afterInitialFailure.push(registration));
    expect(afterInitialFailure).toEqual([]);

    const partialEvents = createEvents();
    const partiallyAdded: DagRuntimeServiceRegistration[] = [];
    const rolledBack: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(
      partialEvents,
      (registration) => partiallyAdded.push(registration),
      (registration) => rolledBack.push(registration),
    );
    partialEvents.events.on?.(DagRuntimeServiceEvent.Register, () => {
      throw new Error("later listener failed");
    });
    expect(() =>
      registerDagRuntimeService(partialEvents, {
        parentSessionId: "partial",
        sessionGeneration: "partial",
        service,
      }),
    ).toThrow("later listener failed");
    expect(partiallyAdded).toHaveLength(1);
    expect(rolledBack).toEqual(partiallyAdded);

    const stable = registerDagRuntimeService(events, {
      parentSessionId: "stable",
      sessionGeneration: "stable",
      service,
    });
    expect(() =>
      registerDagRuntimeService(throwingEvents, {
        parentSessionId: "replacement",
        sessionGeneration: "replacement",
        service,
      }),
    ).toThrow("listener failed");
    const afterReplacementFailure: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(events, (registration) =>
      afterReplacementFailure.push(registration),
    );
    expect(afterReplacementFailure).toEqual([stable]);

    resetDagRuntimeServiceRegistryForTests();
    const replacementEvents = createEvents();
    const added: DagRuntimeServiceRegistration[] = [];
    const removed: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(
      replacementEvents,
      (registration) => added.push(registration),
      (registration) => removed.push(registration),
    );
    let rejectRegistration = false;
    replacementEvents.events.on?.(DagRuntimeServiceEvent.Register, () => {
      if (rejectRegistration) throw new Error("replacement listener failed");
    });
    const previous = registerDagRuntimeService(replacementEvents, {
      parentSessionId: "previous",
      sessionGeneration: "previous",
      service,
    });
    rejectRegistration = true;
    expect(() =>
      registerDagRuntimeService(replacementEvents, {
        parentSessionId: "failed-replacement",
        sessionGeneration: "failed-replacement",
        service,
      }),
    ).toThrow("replacement listener failed");
    expect(added).toHaveLength(3);
    expect(added[0]).toBe(previous);
    expect(added[2]).toBe(previous);
    expect(removed).toEqual([added[1]]);
  });

  it("delivers a raw current unregister once to every subscriber", () => {
    const events = createEvents();
    const registration = registerDagRuntimeService(events, {
      parentSessionId: "parent",
      sessionGeneration: "generation",
      service,
    });
    const removedA: DagRuntimeServiceRegistration[] = [];
    const removedB: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(
      events,
      () => {},
      (removed) => removedA.push(removed),
    );
    listenForDagRuntimeService(
      events,
      () => {},
      (removed) => removedB.push(removed),
    );

    events.events.emit(DagRuntimeServiceEvent.Unregister, registration);
    events.events.emit(DagRuntimeServiceEvent.Unregister, registration);
    events.events.emit(DagRuntimeServiceEvent.Register, registration);
    events.events.emit(DagRuntimeServiceEvent.Unregister, registration);

    expect(removedA).toEqual([registration, registration]);
    expect(removedB).toEqual([registration, registration]);
    const late: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(events, (active) => late.push(active));
    expect(late).toEqual([]);
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
