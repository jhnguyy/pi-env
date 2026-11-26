#!/bin/sh
# Exercise our retained-data projection with native fixture conversion, not detection.
# CI runs this through scripts/trivy-scan.sh check-report in the pinned container.
set -eu
SCRIPTS="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)"
TRIVY="${TRIVY_TEST_BINARY:-trivy}"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export HOME="$TEMP" TRIVY_CACHE_DIR="$TEMP/cache"
"$TRIVY" convert --quiet --config /dev/null --format template \
  --template "@$SCRIPTS/trivy-actionable.tpl" \
  --output "$TEMP/report.txt" "$SCRIPTS/__tests__/fixtures/trivy-redaction.json"

# Empty output cannot establish privacy: identities and remediation must survive.
for expected in 'fixture-secret-rule' 'Synthetic credential rule' \
  'CVE-fixture' 'fixture-package' '2.0.0' 'fixture-config-rule'; do
  grep -F "$expected" "$TEMP/report.txt" >/dev/null
done
if grep -E 'PRIVATE-|Match|Code|Content|Description' "$TEMP/report.txt"; then
  echo "Trivy template exposed excluded context." >&2
  exit 1
fi
echo "Trivy native template redaction passed."
