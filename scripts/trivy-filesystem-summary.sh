#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/trivy-filesystem-summary.sh <report.txt> <scan-status>" >&2
  exit 2
fi

report_path="$1"
scan_status="$2"
max_findings=50

# Never copy report lines: template fields can contain secret context.
append_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  if (
    printf '\n## Trivy source scan\n\n%s\n\nScanner exit status: %s\n' "$1" "$scan_status"
    if [ "$#" -gt 1 ]; then
      printf '\n| Actionable HIGH/CRITICAL findings | Count |\n| --- | ---: |\n'
      printf '| Vulnerabilities | %s |\n| Secrets | %s |\n| Misconfigurations | %s |\n| Total | %s |\n' \
        "$vulnerability_count" "$secret_count" "$misconfig_count" "$finding_count"
      printf '\nCounts only; secret matches and report context are omitted.\n'
    fi
  ) >> "$GITHUB_STEP_SUMMARY"; then
    :
  else
    echo "Could not append Trivy source step summary." >&2
  fi
}

case "$scan_status" in
  ''|*[!0-9]*)
    echo "Trivy scan status must be a nonnegative integer." >&2
    exit 2
    ;;
esac

if [ ! -f "$report_path" ]; then
  append_summary "Scanner/report error: no report produced. Policy result unavailable."
  echo "Trivy scanner failed before it produced a report." >&2
  if [ "$scan_status" -eq 0 ]; then
    exit 2
  fi
  exit "$scan_status"
fi

# grep status 1 means no matches; status >1 means the report could not be read.
report_status=0
finding_count="$(grep -Ec '^(VULNERABILITY|SECRET|MISCONFIGURATION) ' "$report_path")" || report_status=$?
if [ "$report_status" -gt 1 ]; then
  append_summary "Scanner/report error: report could not be read. Policy result unavailable."
  if [ "$scan_status" -eq 0 ]; then
    exit 2
  fi
  exit "$scan_status"
fi
vulnerability_count="$(grep -c '^VULNERABILITY ' "$report_path" || true)"
secret_count="$(grep -c '^SECRET ' "$report_path" || true)"
misconfig_count="$(grep -c '^MISCONFIGURATION ' "$report_path" || true)"

if [ "$scan_status" -eq 0 ]; then
  if [ "$finding_count" -ne 0 ]; then
    append_summary "Scanner/report error: findings contradict successful scanner status. Policy result unavailable." counts
    echo "Trivy produced policy findings but returned a successful status." >&2
    exit 2
  fi
  append_summary "Scanner succeeded: no actionable HIGH/CRITICAL findings." counts
  echo "Trivy policy: no actionable HIGH/CRITICAL findings."
  exit 0
fi

if [ "$finding_count" -eq 0 ]; then
  append_summary "Scanner error: no actionable findings reported; this is not a clean scan."
  echo "Trivy scanner failed before it produced actionable findings." >&2
  exit "$scan_status"
fi

if [ "$scan_status" -eq 1 ]; then
  append_summary "Policy findings: actionable HIGH/CRITICAL findings reported." counts
else
  append_summary "Scanner error: report contains findings, but scan completion is not confirmed." counts
fi

echo "Trivy policy: $finding_count actionable HIGH/CRITICAL finding(s)."
grep -E '^(VULNERABILITY|SECRET|MISCONFIGURATION) ' "$report_path" | sed -n "1,${max_findings}p"

if [ "$finding_count" -gt "$max_findings" ]; then
  omitted_count=$((finding_count - max_findings))
  echo "Trivy omitted $omitted_count additional finding(s) from the job log."
fi

exit "$scan_status"
