#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${TRIVY_RUNTIME:-auto}"
IMAGE="${TRIVY_IMAGE:-aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f}"
CACHE_DIR="${TRIVY_CACHE_DIR:-${TMPDIR:-/tmp}/pi-env-trivy-cache}"

case "$RUNTIME" in
  auto)
    if command -v docker >/dev/null 2>&1; then
      RUNTIME=docker
    elif command -v podman >/dev/null 2>&1; then
      RUNTIME=podman
    else
      echo "Trivy scan requires Docker or Podman. Host Trivy execution is disabled." >&2
      exit 127
    fi
    ;;
  docker|podman)
    if ! command -v "$RUNTIME" >/dev/null 2>&1; then
      echo "TRIVY_RUNTIME=$RUNTIME selected but $RUNTIME is not on PATH." >&2
      exit 127
    fi
    ;;
  local|trivy)
    echo "Host Trivy execution is disabled. Use Docker or Podman." >&2
    exit 2
    ;;
  *)
    echo "Unsupported TRIVY_RUNTIME=$RUNTIME; use auto, docker, or podman." >&2
    exit 2
    ;;
esac

if [[ ! "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "TRIVY_IMAGE must be pinned by SHA-256 digest." >&2
  exit 2
fi

SCAN_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/pi-env-trivy.XXXXXXXX")"
trap 'rm -rf -- "$SCAN_TEMP"' EXIT
SCAN_ROOT="$SCAN_TEMP/source"
bash "$SCRIPT_DIR/trivy-snapshot.sh" "$SCAN_ROOT"
mkdir -p "$CACHE_DIR"

trivy_args=(
  fs
  --quiet
  --scanners "${TRIVY_SCANNERS:-vuln,secret,misconfig}"
  --file-patterns "${TRIVY_FILE_PATTERNS:-pnpm:nub.lock}"
  --skip-dirs node_modules
  --skip-dirs .git
  --severity "${TRIVY_SEVERITY:-HIGH,CRITICAL}"
  --include-dev-deps
  --ignore-unfixed
  --ignorefile .trivyignore.yaml
  --exit-code "${TRIVY_EXIT_CODE:-1}"
  --skip-version-check
  --format template
  --template @scripts/trivy-actionable.tpl
)

"$RUNTIME" run --rm \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --user "$(id -u):$(id -g)" \
  --workdir /work \
  -e HOME=/tmp \
  -e TRIVY_CACHE_DIR=/cache \
  -v "$SCAN_ROOT:/work:ro" \
  -v "$CACHE_DIR:/cache:rw" \
  "$IMAGE" \
  "${trivy_args[@]}" \
  .
