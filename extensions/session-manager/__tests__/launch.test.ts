import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  LaunchParseFailure,
  classifyStartupClaim,
  parseLaunchIntent,
  parseRuntimeMetadata,
  parseStartupClaim,
} from "../launch.js";

const workspaceId = "a".repeat(64);
const launchId = "123e4567-e89b-42d3-a456-426614174000";
const runtimeId = "123e4567-e89b-42d3-a456-426614174001";

function successOf<A, E>(result: Result.Result<A, E>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function failureOf<A, E>(result: Result.Result<A, E>): E {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected failure");
  return result.failure;
}

describe("session launch protocol", () => {
  it("parses ordinary, coordinator, and restored-work launch intent", () => {
    expect(successOf(parseLaunchIntent({ TMUX_PANE: "%1" }))).toEqual({
      kind: "ordinary",
      paneId: "%1",
    });
    expect(
      successOf(
        parseLaunchIntent({
          TMUX_PANE: "%1",
          PI_ENV_SESSION_MANAGER_EXPECTED: "1",
          PI_ENV_SESSION_MANAGER_ROLE: "coordinator",
          PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceId,
          PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: "coordinator-a",
          PI_ENV_SESSION_MANAGER_LAUNCH_ID: launchId,
          PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
          PI_ENV_PI_WRAPPER: "/bin/pi",
        }),
      ),
    ).toEqual({
      kind: "coordinator",
      paneId: "%1",
      workspaceId,
      expectedSessionId: "coordinator-a",
      launchId,
      extensionPath: "/extension.js",
      wrapperPath: "/bin/pi",
    });
    expect(
      successOf(
        parseLaunchIntent({
          TMUX_PANE: "%2",
          PI_ENV_SESSION_MANAGER_EXPECTED: "1",
          PI_ENV_SESSION_MANAGER_ROLE: "work",
          PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceId,
          PI_ENV_SESSION_MANAGER_COORDINATOR_ID: "coordinator-a",
          PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: "work-a",
          PI_ENV_SESSION_MANAGER_LAUNCH_ID: launchId,
          PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
        }),
      ),
    ).toMatchObject({ kind: "restored-work", coordinatorSessionId: "coordinator-a" });
  });

  it("rejects partial and role-inapplicable managed environments", () => {
    for (const environment of [
      { PI_ENV_SESSION_MANAGER_EXPECTED: "1" },
      {
        TMUX_PANE: "%1",
        PI_ENV_SESSION_MANAGER_EXPECTED: "1",
        PI_ENV_SESSION_MANAGER_ROLE: "coordinator",
        PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceId,
        PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: "coordinator-a",
        PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
        PI_ENV_PI_WRAPPER: "/bin/pi",
      },
      {
        TMUX_PANE: "%1",
        PI_ENV_SESSION_MANAGER_EXPECTED: "1",
        PI_ENV_SESSION_MANAGER_ROLE: "work",
        PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceId,
        PI_ENV_SESSION_MANAGER_COORDINATOR_ID: "coordinator-a",
        PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: "work-a",
        PI_ENV_SESSION_MANAGER_LAUNCH_ID: launchId,
        PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
        PI_ENV_PI_WRAPPER: "/bin/pi",
      },
    ]) {
      expect(failureOf(parseLaunchIntent(environment))).toBeInstanceOf(LaunchParseFailure);
    }
  });

  it("parses only exact startup claim artifacts", () => {
    const claim = successOf(
      parseStartupClaim(
        JSON.stringify({
          version: 1,
          workspaceId,
          coordinatorSessionId: "coordinator-a",
          launchId,
          pid: 42,
          createdAt: 10_000,
        }),
      ),
    );

    expect(claim).toMatchObject({ coordinatorSessionId: "coordinator-a", pid: 42 });
    expect(
      failureOf(parseStartupClaim(JSON.stringify({ ...claim, unexpected: true }))),
    ).toBeInstanceOf(LaunchParseFailure);
  });

  it("keeps every matching live claim authoritative", () => {
    const createdAt = 10_000;
    const claim = successOf(
      parseStartupClaim(
        JSON.stringify({
          version: 1,
          workspaceId,
          coordinatorSessionId: "coordinator-a",
          launchId,
          pid: 42,
          createdAt,
        }),
      ),
    );

    expect(
      classifyStartupClaim(
        claim,
        {
          workspaceId,
          coordinatorSessionId: "coordinator-a",
          now: createdAt + 30_000,
        },
        () => true,
      ),
    ).toBe("starting");
    expect(
      classifyStartupClaim(
        claim,
        {
          workspaceId,
          coordinatorSessionId: "coordinator-a",
          now: createdAt + 30_001,
        },
        () => true,
      ),
    ).toBe("unresponsive");
    expect(
      classifyStartupClaim(
        claim,
        { workspaceId, coordinatorSessionId: "coordinator-a", now: createdAt },
        () => false,
      ),
    ).toBe("replaceable");
  });

  it("parses exact runtime metadata and rejects reduced artifacts", () => {
    expect(
      successOf(
        parseRuntimeMetadata(
          JSON.stringify({
            version: 1,
            workspaceId,
            coordinatorSessionId: "coordinator-a",
            runtimeId,
            pid: 42,
            socketPath: "/tmp/coordinator.sock",
          }),
        ),
      ),
    ).toMatchObject({ runtimeId, socketPath: "/tmp/coordinator.sock" });
    expect(
      failureOf(
        parseRuntimeMetadata(
          JSON.stringify({ version: 1, workspaceId, coordinatorSessionId: "coordinator-a" }),
        ),
      ),
    ).toBeInstanceOf(LaunchParseFailure);
  });
});
