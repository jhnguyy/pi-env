import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdir, readFile, realpath, lstat } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Schedule } from "effect";
import {
  connect,
  type InspectionView,
  type ServiceView,
} from "../../../src/subagent-service/client";

class SubagentServiceConnectionError extends Data.TaggedError("SubagentServiceConnectionError")<{
  readonly cause: unknown;
}> {}

export interface SubagentServiceConnection {
  readonly signal: AbortSignal;
  readonly view: Pick<
    ServiceView,
    "submit" | "input" | "cancel" | "result" | "reopen" | "closeRun"
  > & {
    readonly snapshot: Pick<ServiceView["snapshot"], "value" | "subscribe">;
  };
  inspect(childId: string): Promise<
    Pick<InspectionView, "refresh" | "release"> & {
      readonly snapshot: Pick<InspectionView["snapshot"], "value">;
    }
  >;
  close(): Promise<void>;
}

async function prepareServiceDirectory(directory: string | undefined): Promise<string> {
  if (
    !directory ||
    !isAbsolute(directory) ||
    Buffer.byteLength(join(directory, "service.sock")) > 103
  )
    throw new Error(
      "Set PI_ENV_SUBAGENT_STATE_DIR to an explicit short, persistent local private directory (socket path at most 103 bytes); no temporary or in-process fallback is used.",
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Subagent state directory must be owned, non-symlink, mode 0700.");
  return directory;
}

async function openServiceLog(directory: string) {
  const logPath = join(directory, "service.log");
  const logInfo = await lstat(logPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    logInfo &&
    (!logInfo.isFile() ||
      logInfo.nlink !== 1 ||
      logInfo.uid !== process.getuid?.() ||
      (logInfo.mode & 0o7777) !== 0o600)
  )
    throw new Error("Subagent service log must be an owned private regular file.");
  return open(logPath, "a", 0o600);
}

/** The detached executable owns accepted work; this connection never owns its lifetime. */
export async function connectSubagentService(
  parentSessionId: string,
  agentDirectory = getAgentDir(),
): Promise<SubagentServiceConnection> {
  const agentDir = await realpath(agentDirectory);
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    ...(import.meta.url.endsWith(".ts") ? ["dist"] : []),
    "service.js",
  );
  const digest = createHash("sha256")
    .update(await readFile(entry))
    .update(process.version)
    .digest("hex");
  const directory = await prepareServiceDirectory(process.env.PI_ENV_SUBAGENT_STATE_DIR);
  try {
    return await connect(directory, parentSessionId, digest);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
      )
    )
      throw error;
  }
  const log = await openServiceLog(directory);
  try {
    const child = spawn(process.execPath, [entry, directory, agentDir], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Subagent service startup timed out; inspect ${directory}/service.log`));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", message);
        child.off("error", failed);
        child.off("exit", exited);
      };
      const message = (value: unknown) => {
        if (value && typeof value === "object" && "ready" in value && value.ready === true) {
          cleanup();
          resolve();
        }
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = () => {
        cleanup();
        reject(
          new Error(`Subagent service exited during startup; inspect ${directory}/service.log`),
        );
      };
      child.on("message", message);
      child.once("error", failed);
      child.once("exit", exited);
    });
    child.unref();
    try {
      await ready;
    } catch (error) {
      // Another client may have won the service lock. Connecting is safe; no work is repeated.
      try {
        return await Effect.runPromise(
          Effect.tryPromise({
            try: () => connect(directory, parentSessionId, digest),
            catch: (cause) => new SubagentServiceConnectionError({ cause }),
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("100 millis"),
              times: 50,
              while: ({ cause }) =>
                cause instanceof Error &&
                "code" in cause &&
                ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(String(cause.code)),
            }),
          ),
        );
      } catch (connectionError) {
        throw new AggregateError(
          [error, connectionError],
          `Subagent startup did not converge; inspect ${directory}/service.log. An incompatible host for this agent directory may already own another state path.`,
          { cause: connectionError },
        );
      }
    } finally {
      if (child.connected) child.disconnect();
    }
    return await connect(directory, parentSessionId, digest);
  } finally {
    await log.close();
  }
}

export { waitForOperation } from "../../../src/subagent-service/client";
