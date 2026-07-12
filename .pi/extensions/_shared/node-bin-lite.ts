import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dependency-free binary discovery for bootstrap and sidecar processes.
 * Avoid importing the Effect runtime into long-lived daemons for a PATH lookup.
 */
export async function findNodeBinaryLite(name: string, fromUrl: string): Promise<string | null> {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const local = resolvePath(dir, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", 'command -v -- "$1"', "sh", name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("close", (code) => resolve(code === 0 ? output.trim() || null : null));
    child.on("error", () => resolve(null));
  });
}
