// Dependency-free so the pre-install runtime step can report through the same owner.

export function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

export function ok(message) {
  console.log(`  ✓  ${message}`);
}

export function changed(message) {
  console.log(`  →  ${message}`);
}

export function relinked(label) {
  console.log(`  ↺  ${label}. Symbolic link updated.`);
}

export function kept(label) {
  console.log(`  —  ${label} already exists locally. Skip.`);
}

export function note(message) {
  console.log(`  —  ${message}`);
}

export function displayPath(path, home) {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
