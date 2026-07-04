import { existsSync, unlinkSync } from "node:fs";

export interface SocketArtifactFs {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

const defaultFs: SocketArtifactFs = { existsSync, unlinkSync };

/** Remove a stale daemon artifact if it exists. Cleanup is best-effort. */
export function removeStaleArtifact(path: string, fs: SocketArtifactFs = defaultFs): boolean {
  if (!fs.existsSync(path)) return false;

  try {
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove related daemon artifacts together. Cleanup is best-effort per path. */
export function removeStaleArtifacts(paths: readonly string[], fs: SocketArtifactFs = defaultFs): number {
  let removed = 0;
  for (const path of paths) {
    if (removeStaleArtifact(path, fs)) removed += 1;
  }
  return removed;
}
