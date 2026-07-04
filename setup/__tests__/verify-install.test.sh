#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_RUN="$ROOT_DIR/scripts/node-run.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/.pi/extensions/active/dist"
cp "$ROOT_DIR/scripts/extension-manifest.mjs" "$TMP_DIR/scripts/"
cp "$ROOT_DIR/scripts/extension-contract.mjs" "$TMP_DIR/scripts/"
cp "$ROOT_DIR/scripts/verify-install.mjs" "$TMP_DIR/scripts/"

touch "$TMP_DIR/.pi/extensions/active/index.ts" "$TMP_DIR/.pi/extensions/active/dist/index.js"

write_repo() {
  local active_manifest="$1"
  local sidecars="${2:-}"
  if [ -z "$sidecars" ]; then sidecars="{}"; fi
  cat > "$TMP_DIR/package.json" <<JSON
{
  "workspaces": [".pi/extensions/active"],
  "pi": { "extensions": [".pi/extensions/active"] }
}
JSON
  cat > "$TMP_DIR/pi-build.config.json" <<JSON
{
  "extensionsDir": ".pi/extensions",
  "sidecars": $sidecars
}
JSON
  cat > "$TMP_DIR/.pi/extensions/active/package.json" <<JSON
$active_manifest
JSON
}

run_verify() {
  (cd "$TMP_DIR" && "$NODE_RUN" scripts/verify-install.mjs 2>&1)
}

write_repo '{ "name": "@test/active", "type": "module", "private": true, "pi": { "extensions": ["./dist/index.js"] } }'
run_verify >/dev/null
"$NODE_RUN" - "$ROOT_DIR" "$TMP_DIR" <<'JS'
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const rootDir = process.argv[2];
const tmpDir = process.argv[3];
const { loadExtensionManifest } = await import(pathToFileURL(join(rootDir, 'scripts/extension-manifest.mjs')).href);
const { validateExtensionInstall } = await import(pathToFileURL(join(rootDir, 'scripts/extension-contract.mjs')).href);
const manifest = loadExtensionManifest(tmpDir);
if (manifest.repoRoot !== tmpDir) throw new Error('custom repo root was not preserved');
const errors = validateExtensionInstall(manifest);
if (errors.length > 0) throw new Error(errors.join('\n'));
JS
echo 'ok: extension contract can validate an explicit repo root'

write_repo '{ "name": "@test/active", "type": "module", "private": true, "pi": { "extensions": [] } }'
output="$(run_verify || true)"
if grep -q 'active: package.json pi.extensions must include ./dist/index.js' <<<"$output"; then
  echo 'ok: active extension manifest export is enforced'
else
  echo 'missing active extension manifest export failure' >&2
  exit 1
fi

write_repo '{ "name": "@test/active", "type": "module", "private": true, "pi": { "extensions": ["./dist/index.js"] } }'
"$NODE_RUN" - "$TMP_DIR/package.json" <<'JS'
const fs = require('node:fs');
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.pi.extensions.push('./.pi/extensions/active');
fs.writeFileSync(path, JSON.stringify(pkg));
JS
output="$(run_verify || true)"
if grep -q 'duplicate active extension path: .pi/extensions/active' <<<"$output"; then
  echo 'ok: duplicate extension registrations are rejected'
else
  echo 'missing duplicate extension registration failure' >&2
  exit 1
fi

write_repo '{ "name": "@test/active", "type": "module", "private": true, "pi": { "extensions": ["./dist/index.js"] } }' '{ "missing": [{ "entry": "daemon.ts", "outfile": "dist/daemon.js" }] }'
output="$(run_verify || true)"
if grep -q 'sidecar config references inactive extension: missing' <<<"$output"; then
  echo 'ok: inactive sidecar references are rejected'
else
  echo 'missing inactive sidecar failure' >&2
  exit 1
fi

cat > "$TMP_DIR/package.json" <<JSON
{
  "workspaces": [".pi/extensions/active", ".pi/extensions/workspace-only"],
  "pi": { "extensions": [".pi/extensions/active"] }
}
JSON
mkdir -p "$TMP_DIR/.pi/extensions/workspace-only"
write_repo '{ "name": "@test/active", "type": "module", "private": true, "pi": { "extensions": ["./dist/index.js"] } }'
# write_repo rewrites package.json; restore workspace-only mismatch.
"$NODE_RUN" - "$TMP_DIR/package.json" <<'JS'
const fs = require('node:fs');
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.workspaces.push('.pi/extensions/workspace-only');
fs.writeFileSync(path, JSON.stringify(pkg));
JS
output="$(run_verify || true)"
if grep -q 'workspace extension is not registered in package pi.extensions: .pi/extensions/workspace-only' <<<"$output"; then
  echo 'ok: workspace/root extension drift is rejected'
else
  echo 'missing workspace drift failure' >&2
  exit 1
fi
