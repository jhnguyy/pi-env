import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";

const MAX_SOCKET_PATH_BYTES = 100;

export class RuntimePathFailure extends Data.TaggedError("RuntimePathFailure")<{
  path: string;
  reason: string;
}> {}

export type RuntimePaths = {
  readonly directory: string;
  readonly socketPath: string;
  readonly metadataPath: string;
  readonly claimPath: string;
};

export function workspaceId(canonicalCwd: string): string {
  return createHash("sha256").update(canonicalCwd, "utf8").digest("hex");
}

function candidates(environment: NodeJS.ProcessEnv, uid: number): readonly string[] {
  return [
    environment.XDG_RUNTIME_DIR
      ? join(environment.XDG_RUNTIME_DIR, "pi-env", "session-manager")
      : undefined,
    join(tmpdir(), `pi-env-${uid}`, "session-manager"),
    join("/tmp", `pi-env-${uid}`, "session-manager"),
  ].filter((value): value is string => Boolean(value));
}

async function secureDirectory(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("path is not a real directory");
  if (info.uid !== uid) throw new Error("directory has the wrong owner");
  if ((info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if ((secured.mode & 0o077) !== 0) throw new Error("directory is group or world accessible");
  }
  if ((await realpath(path)) !== path) throw new Error("directory path contains a symlink");
}

export function resolveRuntimePaths(
  canonicalCwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.(),
): Effect.Effect<RuntimePaths, RuntimePathFailure> {
  const id = workspaceId(canonicalCwd);
  if (uid === undefined) {
    return Effect.fail(
      new RuntimePathFailure({ path: canonicalCwd, reason: "user ID is unavailable" }),
    );
  }
  return Effect.tryPromise({
    try: async () => {
      const failures: string[] = [];
      for (const directory of candidates(environment, uid)) {
        const socketPath = join(directory, `ws-${id.slice(0, 24)}.sock`);
        if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
          failures.push(`${directory}: socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`);
          continue;
        }
        try {
          await secureDirectory(directory, uid);
          return {
            directory,
            socketPath,
            metadataPath: join(directory, `ws-${id.slice(0, 24)}.json`),
            claimPath: join(directory, `ws-${id.slice(0, 24)}.claim.json`),
          };
        } catch (error) {
          failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(failures.join("; ") || "no runtime directory candidate is available");
    },
    catch: (cause) =>
      new RuntimePathFailure({
        path: canonicalCwd,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
