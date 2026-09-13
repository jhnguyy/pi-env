export const normalizeWorkspacePath = (path: string): string => path.replaceAll("\\", "/");

export const isDriveQualifiedPath = (path: string): boolean => /^[A-Za-z]:/.test(path);

export function isOutsideWorkspace(relativePath: string): boolean {
  const normalized = normalizeWorkspacePath(relativePath);
  return (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    isDriveQualifiedPath(normalized)
  );
}
