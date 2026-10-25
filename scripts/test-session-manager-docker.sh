#!/usr/bin/env bash
set -euo pipefail

PI_ENV_REVISION=$(git describe --always --dirty --abbrev=40)
export PI_ENV_REVISION

docker buildx bake session-manager-e2e-evidence
docker buildx bake session-manager-e2e "$@"
