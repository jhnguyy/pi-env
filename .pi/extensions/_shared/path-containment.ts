import { realpathSync } from "node:fs";
import path from "node:path";

export function isPathContained(root: string, candidate: string): boolean {
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = realpathSync(root);
    canonicalCandidate = realpathSync(candidate);
  } catch {
    return false;
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
