#!/usr/bin/env sh
# Compatibility wrapper. The Node/esbuild implementation lives in
# build-extensions.mjs so it can be shared by npm scripts and direct callers.
set -eu
exec node "$(dirname "$0")/build-extensions.mjs" "$@"
