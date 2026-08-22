import path from "node:path";

export type DagArtifactRelativePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

export function parseDagArtifactRelativePath(relativePath: string): DagArtifactRelativePathResult {
  if (relativePath.length === 0) return { ok: false, message: "path is empty" };
  if (relativePath === ".") return { ok: false, message: "path must name a file" };
  if (relativePath.includes("\0")) return { ok: false, message: "path contains a null byte" };
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath))
    return { ok: false, message: "path must be root-relative" };
  if (relativePath.split(/[\\/]/u).some((segment) => segment === ".."))
    return { ok: false, message: "path must not traverse" };
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized === ".." || path.isAbsolute(normalized))
    return { ok: false, message: "path escapes lexically" };
  return { ok: true, path: normalized };
}

export function isCanonicalChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
