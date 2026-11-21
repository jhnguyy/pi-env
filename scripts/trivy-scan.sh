#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
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
REPORT_DIR="${TRIVY_REPORT_DIR:-$SCAN_TEMP/reports}"
mkdir -p "$CACHE_DIR" "$REPORT_DIR" "$SCAN_TEMP/raw"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd)"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"

sandbox=("$RUNTIME" run --rm
  --cap-drop=ALL
  --security-opt=no-new-privileges
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev
  --user "$(id -u):$(id -g)"
  -e HOME=/tmp
  -e TRIVY_CACHE_DIR=/cache
  -v "$CACHE_DIR:/cache:rw"
  -v "$SCAN_TEMP/raw:/output:rw"
)

case "${1:-filesystem}" in
  image)
    if [[ "$#" -ne 2 || ! -f "$2" ]]; then
      echo "usage: scripts/trivy-scan.sh image <docker-archive>" >&2
      exit 2
    fi
    archive="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    "${sandbox[@]}" -v "$archive:/image.tar:ro" \
      -v "$ROOT/.trivyignore.yaml:/etc/trivy/ignore.yaml:ro" "$IMAGE" image \
      --input /image.tar --quiet --scanners vuln,secret,misconfig \
      --file-patterns pnpm:nub.lock --severity HIGH,CRITICAL \
      --ignorefile /etc/trivy/ignore.yaml --skip-version-check \
      --format json --output /output/image.json
    node "$ROOT/scripts/trivy-image-summary.mjs" "$SCAN_TEMP/raw/image.json" \
      "$REPORT_DIR/trivy-image-results.json"
    ;;
  filesystem)
    if [[ "$#" -gt 1 ]]; then
      echo "usage: scripts/trivy-scan.sh [filesystem | image <docker-archive>]" >&2
      exit 2
    fi
    SCAN_ROOT="$SCAN_TEMP/source"
    mkdir -p "$SCAN_ROOT"
    git -C "$ROOT" archive --format=tar HEAD | tar -xf - -C "$SCAN_ROOT"
    test -f "$SCAN_ROOT/package.json"
    test -f "$SCAN_ROOT/nub.lock"
    fs_args=(fs --quiet --file-patterns "${TRIVY_FILE_PATTERNS:-pnpm:nub.lock}"
      --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-version-check)
    sandbox+=(-v "$SCAN_ROOT:/work:ro" --workdir /work)
    "${sandbox[@]}" "$IMAGE" "${fs_args[@]}" --scanners vuln --list-all-pkgs \
      --format json --output /output/inventory.json .
    # Require a populated lockfile target, not incidental packages from other files.
    node --input-type=module - "$SCAN_TEMP/raw/inventory.json" "$REPORT_DIR/trivy-dependency-inventory.json" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const [input, output] = process.argv.slice(2);
const report = JSON.parse(readFileSync(input, "utf8"));
const packages = (report.Results ?? []).filter((result) => result.Target === "nub.lock")
  .reduce((count, result) => count + (result.Packages?.length ?? 0), 0);
if (packages < 10) throw new Error("Trivy did not report a populated nub.lock inventory.");
const inventory = report.Results.filter((result) => result.Target === "nub.lock")
  .flatMap((result) => result.Packages ?? [])
  .map(({ Name, Version }) => ({ name: Name, version: Version }));
writeFileSync(output, `${JSON.stringify({ target: "nub.lock", packages: inventory })}\n`);
console.log(`Trivy dependency inventory: nub.lock (${packages} packages).`);
JS
    status=0
    "${sandbox[@]}" "$IMAGE" "${fs_args[@]}" \
      --scanners "${TRIVY_SCANNERS:-vuln,secret,misconfig}" \
      --severity "${TRIVY_SEVERITY:-HIGH,CRITICAL}" --ignore-unfixed \
      --ignorefile .trivyignore.yaml --exit-code 1 --format template \
      --template @scripts/trivy-actionable.tpl --output /output/policy.txt . || status=$?
    bash "$ROOT/scripts/trivy-filesystem-summary.sh" "$SCAN_TEMP/raw/policy.txt" "$status" \
      "$REPORT_DIR/trivy-policy-results.txt"
    ;;
  *)
    echo "usage: scripts/trivy-scan.sh [filesystem | image <docker-archive>]" >&2
    exit 2
    ;;
esac
