#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

output=$(scripts/node-run.sh scripts/verify.mjs --list)

for expected in \
  "setup-tests: setup tests — nub run test:setup" \
  "typecheck: typecheck — nub run typecheck" \
  "quality-analysis: quality analysis — nub run check:quality" \
  "build: extension build — nub run build" \
  "install-readiness: install readiness — scripts/node-run.sh scripts/verify-install.mjs" \
  "unit-tests: unit tests — nub run test:unit"
do
  if [[ "$output" != *"$expected"* ]]; then
    echo "FAIL: verify --list missing: $expected" >&2
    echo "$output" >&2
    exit 1
  fi
done

echo "verify plan tests passed"
