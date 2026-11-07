import { isAbsolute } from "node:path";
import { Data, Result, Schema } from "effect";

export type Environment = Readonly<Record<string, string | undefined>>;

export class LaunchParseFailure extends Data.TaggedError("LaunchParseFailure")<{
  reason: string;
}> {}

export type OrdinaryLaunch = {
  readonly kind: "ordinary";
  readonly paneId?: string;
};
export type CoordinatorLaunch = {
  readonly kind: "coordinator";
  readonly paneId: string;
  readonly workspaceId: string;
  readonly expectedSessionId: string;
  readonly launchId: string;
  readonly extensionPath: string;
  readonly wrapperPath: string;
};
export type RestoredWorkLaunch = {
  readonly kind: "restored-work";
  readonly paneId: string;
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly expectedSessionId: string;
  readonly launchId: string;
  readonly extensionPath: string;
};
export type LaunchIntent = OrdinaryLaunch | CoordinatorLaunch | RestoredWorkLaunch;

const managedKeys = [
  "PI_ENV_SESSION_MANAGER_EXPECTED",
  "PI_ENV_SESSION_MANAGER_ROLE",
  "PI_ENV_SESSION_MANAGER_WORKSPACE_ID",
  "PI_ENV_SESSION_MANAGER_COORDINATOR_ID",
  "PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID",
  "PI_ENV_SESSION_MANAGER_LAUNCH_ID",
  "PI_ENV_SESSION_MANAGER_EXTENSION",
  "PI_ENV_PI_WRAPPER",
] as const;

const safeText = (value: string | undefined, maximum = 256): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") > 0 &&
  Buffer.byteLength(value, "utf8") <= maximum &&
  !/[\0\r\n]/.test(value);
const workspaceId = (value: string | undefined): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uuid = (value: string | undefined): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const absolutePath = (value: string | undefined): value is string =>
  safeText(value, 4096) && isAbsolute(value);
const failure = <A = never>(reason: string): Result.Result<A, LaunchParseFailure> =>
  Result.fail(new LaunchParseFailure({ reason }));

type ManagedLaunchBase = {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly expectedSessionId: string;
  readonly launchId: string;
  readonly extensionPath: string;
};

function parseManagedBase(
  environment: Environment,
): Result.Result<ManagedLaunchBase, LaunchParseFailure> {
  const paneId = environment.TMUX_PANE;
  const id = environment.PI_ENV_SESSION_MANAGER_WORKSPACE_ID;
  const expectedSessionId = environment.PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID;
  const launchId = environment.PI_ENV_SESSION_MANAGER_LAUNCH_ID;
  const extensionPath = environment.PI_ENV_SESSION_MANAGER_EXTENSION;
  if (
    !safeText(paneId) ||
    !workspaceId(id) ||
    !safeText(expectedSessionId) ||
    !uuid(launchId) ||
    !absolutePath(extensionPath)
  ) {
    return failure("managed launch environment is invalid or incomplete");
  }
  return Result.succeed({ paneId, workspaceId: id, expectedSessionId, launchId, extensionPath });
}

function parseCoordinatorLaunch(
  environment: Environment,
  base: ManagedLaunchBase,
): Result.Result<CoordinatorLaunch, LaunchParseFailure> {
  const wrapperPath = environment.PI_ENV_PI_WRAPPER;
  if (
    environment.PI_ENV_SESSION_MANAGER_COORDINATOR_ID !== undefined ||
    !absolutePath(wrapperPath)
  ) {
    return failure("coordinator launch environment is invalid or incomplete");
  }
  return Result.succeed({ kind: "coordinator", ...base, wrapperPath });
}

function parseRestoredWorkLaunch(
  environment: Environment,
  base: ManagedLaunchBase,
): Result.Result<RestoredWorkLaunch, LaunchParseFailure> {
  const coordinatorSessionId = environment.PI_ENV_SESSION_MANAGER_COORDINATOR_ID;
  if (!safeText(coordinatorSessionId) || environment.PI_ENV_PI_WRAPPER !== undefined) {
    return failure("restored-work launch environment is invalid or incomplete");
  }
  return Result.succeed({ kind: "restored-work", ...base, coordinatorSessionId });
}

export function parseLaunchIntent(environment: Environment): Result.Result<
  LaunchIntent,
  LaunchParseFailure
> {
  if (!managedKeys.some((key) => environment[key] !== undefined)) {
    return Result.succeed({
      kind: "ordinary",
      ...(environment.TMUX_PANE ? { paneId: environment.TMUX_PANE } : {}),
    });
  }
  if (environment.PI_ENV_SESSION_MANAGER_EXPECTED !== "1") {
    return failure("partial managed launch environment");
  }
  const base = parseManagedBase(environment);
  if (Result.isFailure(base)) return Result.fail(base.failure);
  switch (environment.PI_ENV_SESSION_MANAGER_ROLE) {
    case "coordinator":
      return parseCoordinatorLaunch(environment, base.success);
    case "work":
      return parseRestoredWorkLaunch(environment, base.success);
    default:
      return failure("managed launch role is invalid");
  }
}

const StartupClaimSchema = Schema.Struct({
  version: Schema.Literal(1),
  workspaceId: Schema.String,
  coordinatorSessionId: Schema.String,
  launchId: Schema.String,
  pid: Schema.Number,
  createdAt: Schema.Number,
});
const RuntimeMetadataSchema = Schema.Struct({
  version: Schema.Literal(1),
  workspaceId: Schema.String,
  coordinatorSessionId: Schema.String,
  runtimeId: Schema.String,
  pid: Schema.Number,
  socketPath: Schema.String,
});
const decodeClaim = Schema.decodeUnknownSync(StartupClaimSchema, { onExcessProperty: "error" });
const decodeMetadata = Schema.decodeUnknownSync(RuntimeMetadataSchema, {
  onExcessProperty: "error",
});

export type StartupClaim = typeof StartupClaimSchema.Type;
export type RuntimeMetadata = typeof RuntimeMetadataSchema.Type;

function parseJson(text: string): Result.Result<unknown, LaunchParseFailure> {
  if (Buffer.byteLength(text, "utf8") > 4096) {
    return failure("runtime artifact exceeds 4096 bytes");
  }
  try {
    return Result.succeed(JSON.parse(text));
  } catch {
    return failure("invalid JSON");
  }
}

export function parseStartupClaim(text: string): Result.Result<StartupClaim, LaunchParseFailure> {
  const json = parseJson(text);
  if (Result.isFailure(json)) return Result.fail(json.failure);
  try {
    const claim = decodeClaim(json.success);
    if (
      !workspaceId(claim.workspaceId) ||
      !safeText(claim.coordinatorSessionId) ||
      !uuid(claim.launchId) ||
      !Number.isSafeInteger(claim.pid) ||
      claim.pid <= 0 ||
      !Number.isSafeInteger(claim.createdAt) ||
      claim.createdAt < 0
    ) {
      return failure("invalid startup claim fields");
    }
    return Result.succeed(claim);
  } catch {
    return failure("invalid strict startup claim");
  }
}

export function parseRuntimeMetadata(
  text: string,
): Result.Result<RuntimeMetadata, LaunchParseFailure> {
  const json = parseJson(text);
  if (Result.isFailure(json)) return Result.fail(json.failure);
  try {
    const metadata = decodeMetadata(json.success);
    if (
      !workspaceId(metadata.workspaceId) ||
      !safeText(metadata.coordinatorSessionId) ||
      !uuid(metadata.runtimeId) ||
      !Number.isSafeInteger(metadata.pid) ||
      metadata.pid <= 0 ||
      !absolutePath(metadata.socketPath)
    ) {
      return failure("invalid runtime metadata fields");
    }
    return Result.succeed(metadata);
  } catch {
    return failure("invalid strict runtime metadata");
  }
}

type ExpectedStartupClaim = {
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly now: number;
};

function isCurrentStartupClaim(
  claim: StartupClaim,
  expected: ExpectedStartupClaim,
): boolean {
  const age = expected.now - claim.createdAt;
  return (
    claim.workspaceId === expected.workspaceId &&
    claim.coordinatorSessionId === expected.coordinatorSessionId &&
    age >= 0 &&
    age <= 30_000
  );
}

export function classifyStartupClaim(
  claim: StartupClaim,
  expected: ExpectedStartupClaim,
  processAlive: (pid: number) => boolean,
): "replaceable" | "starting" | "unresponsive" {
  if (
    claim.workspaceId !== expected.workspaceId ||
    claim.coordinatorSessionId !== expected.coordinatorSessionId ||
    !processAlive(claim.pid)
  ) {
    return "replaceable";
  }
  return isCurrentStartupClaim(claim, expected) ? "starting" : "unresponsive";
}
