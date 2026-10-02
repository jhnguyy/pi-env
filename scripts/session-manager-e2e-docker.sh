#!/usr/bin/env bash
# Builds the session-manager E2E image target from committed HEAD and runs it,
# keeping result.json evidence on the host.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
REVISION=$(git -C "$ROOT" rev-parse HEAD)
IMAGE=${PI_ENV_E2E_IMAGE:-pi-env:session-manager-e2e}
# Default under HOME: Docker Desktop shares it, but often not /tmp.
ARTIFACTS=${PI_ENV_E2E_ARTIFACT_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-env/session-manager-e2e}
CONTEXT=$(mktemp -d "${TMPDIR:-/tmp}/pi-env-e2e-context.XXXXXX")
trap 'rm -rf "$CONTEXT"' EXIT

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "warning: uncommitted changes are not included; testing $REVISION" >&2
fi
# A worktree's .git file points outside the build context, so build from a clone.
git clone --quiet --no-hardlinks "$ROOT" "$CONTEXT"
git -C "$CONTEXT" checkout --quiet --detach "$REVISION"

mkdir -p "$ARTIFACTS"
# Docker Desktop shares physical paths only; macOS /tmp is a symlink.
ARTIFACTS=$(cd "$ARTIFACTS" && pwd -P)
# The container runs as the image's node user, which may not match the host UID.
chmod 0777 "$ARTIFACTS"

DOCKER_BUILDKIT=1 docker build --file "$CONTEXT/Dockerfile" --target session-manager-e2e \
  --tag "$IMAGE" "$CONTEXT"
if ! docker run --rm --entrypoint sh -v "$ARTIFACTS:/artifacts" "$IMAGE" -c 'test -w /artifacts'; then
  echo "error: $ARTIFACTS is not writable in the container; share it with Docker or set PI_ENV_E2E_ARTIFACT_DIR" >&2
  exit 1
fi
status=0
docker run --rm -e "PI_ENV_REVISION=$REVISION" -v "$ARTIFACTS:/artifacts" "$IMAGE" || status=$?
echo "Session-manager E2E evidence: $ARTIFACTS"
exit "$status"
