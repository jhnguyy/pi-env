import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdir, readFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  connect,
  type InspectionView,
  type ServiceView,
} from "../../../src/subagent-service/client";

export interface SubagentServiceConnection {
  readonly signal: AbortSignal;
  readonly view: Pick<
    ServiceView,
    "submit" | "input" | "cancel" | "result" | "resultFull" | "reopen" | "closeRun"
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
  const identity = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
  const directory = join("/tmp", `pi-sa-${process.getuid?.()}-${identity}`, "v2");
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
  const log = await open(join(directory, "service.log"), "a", 0o600);
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
        return await connect(directory, parentSessionId, digest);
      } catch {
        throw error;
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
