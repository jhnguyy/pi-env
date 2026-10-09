# syntax=docker/dockerfile:1.7

# pi-env composable image artifact.
#
# This image intentionally mirrors the canonical local Nub build path:
#   nub install --frozen-lockfile
#   nub run build
#   nub run verify
#
# The image is a reusable CI/toolchain artifact with prebuilt extension bundles. It
# is not the only supported build path and does not run setup.sh or hydrate any
# machine-local identity/state.
#
# Targets (see docker-bake.hcl):
#   pi-env                        published image; the default (last) stage
#   session-manager-e2e-evidence  exports session-manager E2E evidence
#   session-manager-e2e           fails when the session-manager E2E fails
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS toolchain

ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

USER root
RUN export DEBIAN_FRONTEND=noninteractive \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    tini \
    util-linux \
  && npm install --global --omit=dev @nubjs/nub@0.9.5 \
  && nub --version \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && rm -rf /var/lib/apt/lists/* \
  && node --version

WORKDIR ${PI_ENV_HOME}

FROM toolchain AS pi-env

LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="pi-env CI/toolchain image artifact with locked Nub dependencies and prebuilt extension bundles" \
  org.opencontainers.image.source="https://github.com/jhnguyy/pi-env" \
  org.opencontainers.image.licenses="MIT"

COPY --chown=node:node . .
RUN chown -R node:node ${PI_ENV_HOME}

USER node

# Keep Nub's content-addressed download store and build-only lint binary out of
# immutable image layers. BuildKit does not run the image entrypoint, so Tini
# must reap detached test descendants during verification.
RUN --mount=type=cache,target=/home/node/.local/share/nub/store,uid=1000,gid=1000 \
  nub install --frozen-lockfile \
  && nub run licenses:generate \
    --package-root /usr/local/lib/node_modules \
    --system-license node-LICENSE.txt=/usr/local/LICENSE \
  && nub run build \
  && tini -s -- nub run verify \
  && find ${PI_ENV_HOME}/node_modules/.store \
    -path '*/node_modules/@oxlint-tsgolint/*/tsgolint' -type f -delete

USER root
RUN find /home/node/.cache/nub/node -path '*/lib/node_modules/npm' -prune -exec rm -rf {} + \
  && find /home/node/.cache/nub/node \( -name npm -o -name npx \) -type l -delete \
  && rm -rf /home/node/.cache/nub/pm/packuments-full-v1 \
  && rm -rf /home/node/.local/share/nub/store \
  && rm -rf ${PI_ENV_HOME}/.git

USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["nub", "run", "verify:install"]

# Session-manager E2E: real Pi in an isolated tmux server. It builds from the
# toolchain stage so it does not depend on the published image's verify gate,
# which needs Git metadata. The run stage always succeeds so that evidence can
# be exported; the session-manager-e2e stage is the pass/fail gate.
FROM toolchain AS session-manager-e2e-run
RUN export DEBIAN_FRONTEND=noninteractive \
  && apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/* \
  && chown node:node ${PI_ENV_HOME}
COPY --chown=node:node . .
USER node
RUN --mount=type=cache,target=/home/node/.local/share/nub/store,uid=1000,gid=1000 \
  nub install --frozen-lockfile \
  && nub run build
ARG PI_ENV_REVISION=unknown
RUN mkdir -p /tmp/e2e-evidence \
  && { PI_ENV_REVISION="$PI_ENV_REVISION" PI_ENV_E2E_ARTIFACT_DIR=/tmp/e2e-evidence \
      tini -s -- nub run test:e2e:session-manager; echo "$?" > /tmp/e2e-evidence/exit-code; } 2>&1 \
    | tee /tmp/e2e-evidence/vitest.log \
  && { cp /tmp/e2e-evidence/*/result.json /tmp/e2e-evidence/result.json 2>/dev/null \
    || echo '{"status":"missing"}' > /tmp/e2e-evidence/result.json; }

FROM scratch AS session-manager-e2e-evidence
COPY --from=session-manager-e2e-run /tmp/e2e-evidence/exit-code /tmp/e2e-evidence/vitest.log \
  /tmp/e2e-evidence/result.json /

FROM session-manager-e2e-run AS session-manager-e2e
RUN test "$(cat /tmp/e2e-evidence/exit-code)" = 0 \
  || { cat /tmp/e2e-evidence/result.json; exit 1; }

# Keep the published image as the default (last) build target.
FROM pi-env
