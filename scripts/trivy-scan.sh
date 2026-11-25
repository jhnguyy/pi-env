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
  -v "$ROOT/scripts:/templates:ro"
)

case "${1:-filesystem}" in
  check-report)
    "${sandbox[@]}" --network none \
      -v "$ROOT/.trivyignore.yaml:/etc/trivy/ignore.yaml:ro" \
      --entrypoint sh "$IMAGE" -c \
      'sh /templates/__tests__/trivy-template.test.sh && sh /templates/__tests__/trivy-exceptions.test.sh /etc/trivy/ignore.yaml'
    exit
    ;;
  image)
    if [[ "$#" -ne 2 || ! -f "$2" ]]; then
      echo "usage: scripts/trivy-scan.sh image <docker-archive>" >&2
      exit 2
    fi
    archive="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    sandbox+=(-v "$archive:/image.tar:ro"
      -v "$ROOT/.trivyignore.yaml:/etc/trivy/ignore.yaml:ro")
    scan=(image --input /image.tar --ignorefile /etc/trivy/ignore.yaml)
    target=()
    ;;
  filesystem)
    if [[ "$#" -gt 1 ]]; then
      echo "usage: scripts/trivy-scan.sh [filesystem | image <docker-archive> | check-report]" >&2
      exit 2
    fi
    SCAN_ROOT="$SCAN_TEMP/source"
    mkdir -p "$SCAN_ROOT"
    git -C "$ROOT" archive --format=tar HEAD | tar -xf - -C "$SCAN_ROOT"
    test -f "$SCAN_ROOT/package.json"
    test -f "$SCAN_ROOT/nub.lock"
    sandbox+=(-v "$SCAN_ROOT:/work:ro" --workdir /work)
    scan=(fs --include-dev-deps --skip-dirs node_modules --skip-dirs .git
      --ignorefile .trivyignore.yaml)
    target=(.)
    ;;
  *)
    echo "usage: scripts/trivy-scan.sh [filesystem | image <docker-archive> | check-report]" >&2
    exit 2
    ;;
esac

scan+=(--quiet --file-patterns "${TRIVY_FILE_PATTERNS:-pnpm:nub.lock}" --skip-version-check)

# Inventory includes unfixed vulnerabilities; only the policy scan checks secrets.
# Keep raw scanner data private and retain only the template's safe projection.
"${sandbox[@]}" "$IMAGE" "${scan[@]}" --scanners vuln --list-all-pkgs \
  --format json --output /output/complete.json "${target[@]}"
"${sandbox[@]}" "$IMAGE" convert --quiet --format template \
  --template @/templates/trivy-actionable.tpl --output /output/complete.txt /output/complete.json
cp "$SCAN_TEMP/raw/complete.txt" "$REPORT_DIR/trivy-complete-results.txt"

if [[ "${1:-filesystem}" == filesystem ]]; then
  "${sandbox[@]}" "$IMAGE" convert --quiet --format template \
    --template @/templates/trivy-inventory.tpl --output /output/inventory.txt /output/complete.json
  packages="$(< "$SCAN_TEMP/raw/inventory.txt")"
  # Count only the actual nub.lock target, never incidental packages elsewhere.
  if [[ ! "$packages" =~ ^[0-9]+$ ]] || (( packages < 10 )); then
    echo "Trivy did not report a populated nub.lock inventory." >&2
    exit 2
  fi
  printf 'Trivy dependency inventory: nub.lock (%s packages).\n' "$packages"
  cp "$SCAN_TEMP/raw/inventory.txt" "$REPORT_DIR/trivy-dependency-inventory.txt"
fi

# v0.72.0 convert lacks --ignore-unfixed. A second native scan keeps Trivy's
# vulnerability-status policy authoritative rather than reimplementing it.
status=0
"${sandbox[@]}" "$IMAGE" "${scan[@]}" --scanners vuln,secret,misconfig \
  --severity HIGH,CRITICAL --ignore-unfixed \
  --exit-code 1 --format template --template @/templates/trivy-actionable.tpl \
  --output /output/policy.txt "${target[@]}" || status=$?
if [[ -f "$SCAN_TEMP/raw/policy.txt" ]]; then
  cp "$SCAN_TEMP/raw/policy.txt" "$REPORT_DIR/trivy-policy-results.txt"
  head -n 60 "$SCAN_TEMP/raw/policy.txt"
fi

summary="Trivy ${1:-filesystem} policy exit status: $status.
Vulnerability inventory — $(head -n 1 "$SCAN_TEMP/raw/complete.txt")
Only fixable HIGH/CRITICAL vulnerabilities and HIGH/CRITICAL secrets or misconfigurations block.
A passing policy does not mean no vulnerabilities. Unfixed vulnerabilities remain informational.
The inventory retains all unsuppressed vulnerability severities, including unfixed vulnerabilities; the policy report contains blocking findings.
Retained reports contain safe metadata, not secret matches or source snippets."
printf '%s\n' "$summary"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY" ||
    echo "Could not append Trivy step summary." >&2
fi
exit "$status"
