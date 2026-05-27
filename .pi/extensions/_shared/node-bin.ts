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

export async function findNodeBinary(name: string, fromUrl: string): Promise<string | null> {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const local = resolvePath(dir, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-lc", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number) => {
      if (code === 0) resolve(out.trim());
      else resolve(null);
    });
  });
}
