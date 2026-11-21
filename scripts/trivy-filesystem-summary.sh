#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: scripts/trivy-filesystem-summary.sh <report.txt> <scan-status> [safe-output.txt]" >&2
  exit 2
fi
report_path="$1"
scan_status="$2"
case "$scan_status" in
  ''|*[!0-9]*) echo "Invalid scanner exit status." >&2; exit 2 ;;
esac

if [ ! -f "$report_path" ]; then
  echo "Trivy scanner failed before it produced a report." >&2
  [ "$scan_status" -ne 0 ] || exit 2
  exit "$scan_status"
fi
report_status=0
finding_count="$(grep -Ec '^(VULNERABILITY|SECRET|MISCONFIGURATION) ' "$report_path")" || report_status=$?
if [ "$report_status" -gt 1 ]; then
  [ "$scan_status" -ne 0 ] || exit 2
  exit "$scan_status"
fi
if [ "$scan_status" -eq 0 ] && [ "$finding_count" -ne 0 ]; then
  echo "Trivy findings contradict successful scanner status." >&2
  exit 2
fi
if [ "$scan_status" -ne 0 ] && [ "$finding_count" -eq 0 ]; then
  echo "Trivy scanner failed before it produced actionable findings." >&2
  exit "$scan_status"
fi
vulnerabilities="$(grep -c '^VULNERABILITY ' "$report_path" || true)"
secrets="$(grep -c '^SECRET ' "$report_path" || true)"
misconfigurations="$(grep -c '^MISCONFIGURATION ' "$report_path" || true)"
body="$(cat <<EOF
## Trivy source findings

| Actionable findings | Count |
| --- | ---: |
| Vulnerabilities | $vulnerabilities |
| Secrets | $secrets |
| Misconfigurations | $misconfigurations |
| Total | $finding_count |

Scanner exit status: $scan_status
EOF
)"
printf '%s\n' "$body"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  if ! printf '%s\n' "$body" >> "$GITHUB_STEP_SUMMARY"; then
    printf '%s\n' 'Could not append Trivy source summary.' >&2
  fi
fi
# The Trivy template owns this projection: identities/remediation, not matches or code.
if [ "$#" -eq 3 ]; then
  awk '/^(VULNERABILITY|SECRET|MISCONFIGURATION) /' "$report_path" > "$3"
fi
awk '/^(VULNERABILITY|SECRET|MISCONFIGURATION) / { if (count++ < 50) print }' "$report_path"
exit "$scan_status"
