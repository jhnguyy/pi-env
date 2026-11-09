#!/usr/bin/env sh
set -eu

profile="${1:-all}"
if [ "$#" -gt 0 ]; then shift; fi

case "$profile" in
  all)
    for stage in syntax imports types; do
      printf '\n==> lint:%s\n' "$stage" >&2
      "$0" "$stage" "$@"
    done
    exit 0
    ;;
  sensors)
    exec scripts/tool-node-run.sh node_modules/oxlint/bin/oxlint \
      --config .oxlintrc-sensors.json --threads=1 "$@"
    ;;
  changed)
    config=.oxlintrc-sensors.json
    set -- --allow no-await-in-loop --no-error-on-unmatched-pattern "$@"
    ;;
  syntax|imports|types) config=".oxlintrc-$profile.json" ;;
  *)
    echo "usage: scripts/lint.sh <all|syntax|imports|types|sensors|changed> [oxlint arguments...]" >&2
    exit 2
    ;;
esac

# Each capability runs in a fresh process so its graphs and plugin state can be released.
exec scripts/tool-node-run.sh node_modules/oxlint/bin/oxlint \
  --config "$config" --threads=1 --deny-warnings \
  --ignore-pattern 'tests/**' --ignore-pattern '**/dist/**' "$@"
