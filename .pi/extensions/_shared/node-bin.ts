/**
 * Shared Node runtime binary discovery.
 *
 * Searches node_modules/.bin from a starting file/directory upward before
 * falling back to PATH. This supports pi package loading from a repo path where
 * workspace binaries live at the repo root, not next to bundled dist files.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

interface BinaryLookupProcess {
  stdout?: { on(event: "data", handler: (data: Buffer) => void): unknown } | null;
  on(event: "close", handler: (code: number) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
}

export interface BinaryLookupEnv {
  exists(path: string): boolean;
  spawn(command: string, args: string[], options: { stdio: ["ignore", "pipe", "ignore"] }): BinaryLookupProcess;
}

const defaultEnv: BinaryLookupEnv = {
  exists: existsSync,
  spawn,
};

function findLocalBinary(name: string, fromUrl: string, env: BinaryLookupEnv): string | null {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const local = resolvePath(dir, "node_modules", ".bin", name);
    if (env.exists(local)) return local;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findPathBinaryEffect(name: string, env: BinaryLookupEnv): Effect.Effect<string | null> {
  return Effect.callback<string | null>((resume) => {
    let settled = false;
    const complete = (value: string | null) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };

    let proc: BinaryLookupProcess;
    try {
      proc = env.spawn("sh", ["-lc", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      complete(null);
      return;
    }

    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number) => complete(code === 0 ? out.trim() : null));
    proc.on("error", () => complete(null));
  });
}

export function findNodeBinaryEffect(
  name: string,
  fromUrl: string,
  env: BinaryLookupEnv = defaultEnv,
): Effect.Effect<string | null> {
  const local = findLocalBinary(name, fromUrl, env);
  return local === null ? findPathBinaryEffect(name, env) : Effect.succeed(local);
}

export async function findNodeBinary(name: string, fromUrl: string): Promise<string | null> {
  return Effect.runPromise(findNodeBinaryEffect(name, fromUrl));
}
