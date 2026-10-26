#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: bash scripts/trivy-snapshot.sh <new-directory>" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
REVISION="$(git -C "$ROOT" rev-parse HEAD)"
OBJECTS="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path objects)"
OBJECT_FORMAT="$(git -C "$ROOT" rev-parse --show-object-format)"
# An existing directory could contain files outside the committed input boundary.
mkdir -- "$1"
METADATA="$(mktemp -d "${TMPDIR:-/tmp}/pi-env-trivy-git.XXXXXXXX")"
trap 'rm -rf -- "$METADATA"' EXIT
git init --bare --quiet --initial-branch=scan --object-format="$OBJECT_FORMAT" "$METADATA"
# Archive attributes must not omit files or substitute their committed contents.
# Isolated metadata also excludes the source repository's local attribute rules.
printf '* -export-ignore -export-subst\n' > "$METADATA/info/attributes"
GIT_OBJECT_DIRECTORY="$OBJECTS" git --git-dir="$METADATA" \
  -c core.attributesFile=/dev/null archive --format=tar "$REVISION" | tar -xf - -C "$1"
