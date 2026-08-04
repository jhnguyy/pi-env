#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/trivy-filesystem-summary.sh <report.txt> <scan-status>" >&2
  exit 2
fi

report_path="$1"
scan_status="$2"
max_findings=50

case "$scan_status" in
  ''|*[!0-9]*)
    echo "Trivy scan status must be a nonnegative integer." >&2
    exit 2
    ;;
esac

if [ ! -f "$report_path" ]; then
  echo "Trivy scanner failed before it produced a report." >&2
  if [ "$scan_status" -eq 0 ]; then
    exit 2
  fi
  exit "$scan_status"
fi

finding_count="$(grep -Ec '^(VULNERABILITY|SECRET|MISCONFIGURATION) ' "$report_path" || true)"

if [ "$scan_status" -eq 0 ]; then
  if [ "$finding_count" -ne 0 ]; then
    echo "Trivy produced policy findings but returned a successful status." >&2
    exit 2
  fi
  echo "Trivy policy: no actionable HIGH/CRITICAL findings."
  exit 0
fi

if [ "$finding_count" -eq 0 ]; then
  echo "Trivy scanner failed before it produced actionable findings." >&2
  exit "$scan_status"
fi

echo "Trivy policy: $finding_count actionable HIGH/CRITICAL finding(s)."
grep -E '^(VULNERABILITY|SECRET|MISCONFIGURATION) ' "$report_path" | sed -n "1,${max_findings}p"

if [ "$finding_count" -gt "$max_findings" ]; then
  omitted_count=$((finding_count - max_findings))
  echo "Trivy omitted $omitted_count additional finding(s) from the job log."
fi

exit "$scan_status"
