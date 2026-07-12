#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
RUNTIME="${TRIVY_RUNTIME:-auto}"
IMAGE="${TRIVY_IMAGE:-aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f}"
CACHE_DIR="${TRIVY_CACHE_DIR:-${TMPDIR:-/tmp}/pi-env-trivy-cache}"

mkdir -p "$CACHE_DIR"

trivy_args=(
  fs
  --scanners "${TRIVY_SCANNERS:-vuln,secret,misconfig}"
  --file-patterns "${TRIVY_FILE_PATTERNS:-pnpm:lock.yaml}"
  --skip-dirs node_modules
  --skip-dirs .git
  --severity "${TRIVY_SEVERITY:-HIGH,CRITICAL}"
  --include-dev-deps
  --ignorefile .trivyignore.yaml
  --exit-code "${TRIVY_EXIT_CODE:-1}"
  --skip-version-check
)

run_local() {
  if ! command -v trivy >/dev/null 2>&1; then
    return 1
  fi

  (cd "$ROOT" && exec trivy "${trivy_args[@]}" .)
}

run_container() {
  local engine="$1"

  if ! command -v "$engine" >/dev/null 2>&1; then
    return 1
  fi

  exec "$engine" run --rm \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev \
    --user "$(id -u):$(id -g)" \
    --workdir /work \
    -e HOME=/tmp \
    -e TRIVY_CACHE_DIR=/cache \
    -v "$ROOT:/work:ro" \
    -v "$CACHE_DIR:/cache:rw" \
    "$IMAGE" \
    "${trivy_args[@]}" \
    .
}

case "$RUNTIME" in
  auto)
    run_container docker || run_container podman || run_local || {
      echo "Trivy scan requires docker, podman, or trivy on PATH." >&2
      exit 127
    }
    ;;
  docker|podman)
    run_container "$RUNTIME" || {
      echo "TRIVY_RUNTIME=$RUNTIME selected but $RUNTIME is not on PATH." >&2
      exit 127
    }
    ;;
  local|trivy)
    run_local || {
      echo "TRIVY_RUNTIME=$RUNTIME selected but trivy is not on PATH." >&2
      exit 127
    }
    ;;
  *)
    echo "Unsupported TRIVY_RUNTIME=$RUNTIME; use auto, docker, podman, or local." >&2
    exit 2
    ;;
esac
