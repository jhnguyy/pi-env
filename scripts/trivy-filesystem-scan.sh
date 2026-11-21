#!/bin/sh
set -eu
mkdir -p "$TRIVY_CACHE_DIR" "$TRIVY_REPORT_DIR"
cd "$TRIVY_SCAN_ROOT"
test -f package.json
test -f nub.lock

trivy fs \
  --quiet \
  --scanners vuln \
  --file-patterns pnpm:nub.lock \
  --include-dev-deps \
  --list-all-pkgs \
  --skip-dirs node_modules \
  --skip-dirs .git \
  --skip-version-check \
  --format json \
  --output "$TRIVY_REPORT_DIR/trivy-dependency-inventory.json" \
  .

if ! grep -q '"Target": *"nub.lock"' "$TRIVY_REPORT_DIR/trivy-dependency-inventory.json"; then
  echo "Trivy did not report nub.lock as a dependency target. Verify the lock format and pnpm file pattern." >&2
  exit 2
fi

package_count="$(grep -c '"Identifier"' "$TRIVY_REPORT_DIR/trivy-dependency-inventory.json" || true)"
if [ "$package_count" -lt 10 ]; then
  echo "Trivy detected only $package_count dependency packages. Verify the lockfile scanner configuration." >&2
  exit 2
fi
echo "Trivy dependency inventory: nub.lock ($package_count packages)."

rm -f "$TRIVY_REPORT_DIR/trivy-policy-results.txt"
set +e
trivy fs \
  --quiet \
  --scanners vuln,secret,misconfig \
  --file-patterns pnpm:nub.lock \
  --skip-dirs node_modules \
  --skip-dirs .git \
  --severity HIGH,CRITICAL \
  --include-dev-deps \
  --ignore-unfixed \
  --ignorefile .trivyignore.yaml \
  --exit-code 1 \
  --skip-version-check \
  --format template \
  --template "@scripts/trivy-actionable.tpl" \
  --output "$TRIVY_REPORT_DIR/trivy-policy-results.txt" \
  .
trivy_status="$?"
set -e

sh scripts/trivy-filesystem-summary.sh "$TRIVY_REPORT_DIR/trivy-policy-results.txt" "$trivy_status"
