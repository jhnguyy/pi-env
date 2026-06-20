#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
IMAGE="${TRIVY_IMAGE:-aquasec/trivy:latest}"
CACHE_DIR="${TRIVY_CACHE_DIR:-${TMPDIR:-/tmp}/pi-env-trivy-cache}"

mkdir -p "$CACHE_DIR"

if command -v trivy >/dev/null 2>&1; then
  exec trivy fs \
    --scanners vuln,secret,misconfig \
    --skip-dirs "$ROOT/node_modules" \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    "$ROOT"
fi

if command -v docker >/dev/null 2>&1; then
  exec docker run --rm \
    -v "$ROOT:/work:ro" \
    -v "$CACHE_DIR:/root/.cache/trivy" \
    "$IMAGE" \
    fs \
    --scanners vuln,secret,misconfig \
    --skip-dirs /work/node_modules \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    /work
fi

if command -v podman >/dev/null 2>&1; then
  exec podman run --rm \
    -v "$ROOT:/work:ro" \
    -v "$CACHE_DIR:/root/.cache/trivy" \
    "$IMAGE" \
    fs \
    --scanners vuln,secret,misconfig \
    --skip-dirs /work/node_modules \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    /work
fi

echo "Trivy scan requires trivy, docker, or podman on PATH." >&2
exit 127
