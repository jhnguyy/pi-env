#!/bin/sh
# Check our Nub exception's boundaries with native Trivy filtering, without a DB.
set -eu
TRIVY="${TRIVY_TEST_BINARY:-trivy}"
IGNORE_FILE="${1:?usage: trivy-exceptions.test.sh <ignore.yaml>}"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export HOME="$TEMP" TRIVY_CACHE_DIR="$TEMP/cache"

cat > "$TEMP/report.json" <<'EOF'
{
  "SchemaVersion": 2,
  "ArtifactName": "exception-scope-fixture",
  "ArtifactType": "container_image",
  "Results": [
    {
      "Target": "nix/store/fixture-nub-0.11.1/share/nub/0.11.1/source/Cargo.lock",
      "Class": "lang-pkgs", "Type": "cargo",
      "Vulnerabilities": [
        {"VulnerabilityID": "GHSA-4w2j-m93h-cj5j", "PkgName": "quinn-proto", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-2026-115905", "PkgName": "zip", "Severity": "CRITICAL"},
        {"VulnerabilityID": "CVE-2026-115907", "PkgName": "zip", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-2026-115908", "PkgName": "zip", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-2026-115909", "PkgName": "zip", "Severity": "HIGH"},
        {"VulnerabilityID": "GHSA-fixture-unaccepted", "PkgName": "fixture", "Severity": "HIGH"}
      ]
    },
    {
      "Target": "nix/store/fixture-nub-0.11.2/share/nub/0.11.2/source/Cargo.lock",
      "Class": "lang-pkgs", "Type": "cargo",
      "Vulnerabilities": [
        {"VulnerabilityID": "GHSA-4w2j-m93h-cj5j", "PkgName": "quinn-proto", "Severity": "HIGH"}
      ]
    },
    {
      "Target": "nix/store/fixture-other/share/Cargo.lock",
      "Class": "lang-pkgs", "Type": "cargo",
      "Vulnerabilities": [
        {"VulnerabilityID": "GHSA-4w2j-m93h-cj5j", "PkgName": "quinn-proto", "Severity": "HIGH"}
      ]
    }
  ]
}
EOF
cat > "$TEMP/report.tpl" <<'EOF'
{{- range . }}{{ $target := .Target }}{{ range .Vulnerabilities }}{{ printf "%s|%s\n" .VulnerabilityID $target }}{{ end }}{{ end -}}
EOF

# Control dates make the boundary checks independent of the day CI runs.
# The real policy's dates remain untouched and govern actual image scanning.
sed 's/expired_at: [0-9-]*/expired_at: 2999-01-01/g' "$IGNORE_FILE" > "$TEMP/active.yaml"
sed 's/expired_at: [0-9-]*/expired_at: 2000-01-01/g' "$IGNORE_FILE" > "$TEMP/expired.yaml"
for policy in active expired; do
  "$TRIVY" convert --quiet --config /dev/null --ignorefile "$TEMP/$policy.yaml" \
    --format template --template "@$TEMP/report.tpl" \
    --output "$TEMP/$policy.txt" "$TEMP/report.json"
done
for id in GHSA-4w2j-m93h-cj5j CVE-2026-115905 CVE-2026-115907 CVE-2026-115908 CVE-2026-115909; do
  accepted="$id|nix/store/fixture-nub-0.11.1/share/nub/0.11.1/source/Cargo.lock"
  if grep -Fx "$accepted" "$TEMP/active.txt"; then
    echo "Active Nub exception did not match its intended target." >&2
    exit 1
  fi
  grep -Fx "$accepted" "$TEMP/expired.txt" >/dev/null
done
# New findings, other Nub versions, and other tools must remain visible.
test "$(wc -l < "$TEMP/active.txt" | tr -d ' ')" = 3
test "$(wc -l < "$TEMP/expired.txt" | tr -d ' ')" = 8
echo "Trivy native exception scope and expiry passed."
