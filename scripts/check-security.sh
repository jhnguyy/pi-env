#!/usr/bin/env bash
set -euo pipefail

if ! command -v trivy >/dev/null 2>&1; then
  if [[ "${REQUIRE_TRIVY:-0}" == "1" ]]; then
    echo "trivy is required but not installed" >&2
    exit 1
  fi
  echo "trivy not installed; skipping security scan (set REQUIRE_TRIVY=1 to make this blocking)"
  exit 0
fi

trivy fs \
  --scanners vuln,secret,misconfig \
  --severity HIGH,CRITICAL \
  --exit-code 1 \
  --ignore-unfixed \
  --skip-dirs node_modules \
  --skip-dirs .git \
  .
