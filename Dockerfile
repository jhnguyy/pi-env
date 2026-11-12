# syntax=docker/dockerfile:1.7

# pi-env composable image artifact.
#
# This image intentionally mirrors the canonical local Nub build path:
#   nub install --frozen-lockfile
#   nub run build
#   nub run verify:full
#
# The image is a reusable CI/toolchain artifact with prebuilt extension bundles. It
# is not the only supported build path and does not run setup.sh or hydrate any
# machine-local identity/state.
#
# Targets (see docker-bake.hcl):
#   pi-env                        published image; the default (last) stage
# Debian's tmux predates the 3.8 baseline that the tmux template and its tests need.
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS tmux-build
COPY scripts/install-tmux.sh /tmp/install-tmux.sh
RUN sh /tmp/install-tmux.sh

FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS toolchain

ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

USER root
COPY package.json /tmp/pi-env-package.json
RUN export DEBIAN_FRONTEND=noninteractive \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    libevent-core-2.1-7 \
    tini \
  && npm install --global --omit=dev "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/pi-env-package.json")).packageManager.replace("nub@", "@nubjs/nub@")')" \
  && nub --version \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && rm -rf /var/lib/apt/lists/* /tmp/pi-env-package.json \
  && node --version

COPY --from=tmux-build /usr/local/bin/tmux /usr/local/bin/tmux
RUN tmux -V

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
  && tini -s -- nub run verify:full \
  && find ${PI_ENV_HOME}/node_modules/.store \
    -path '*/node_modules/@oxlint-tsgolint/*/tsgolint' -type f -delete

USER root
# Nub uses the host Node when compatible, so its managed Node cache is optional.
RUN if [ -e /home/node/.cache/nub/node ]; then \
    find /home/node/.cache/nub/node -path '*/lib/node_modules/npm' -prune -exec rm -rf {} + \
    && find /home/node/.cache/nub/node \( -name npm -o -name npx \) -type l -delete; \
  fi \
  && rm -rf /home/node/.cache/nub/pm/packuments-full-v1 \
  && rm -rf /home/node/.local/share/nub/store \
  && rm -rf ${PI_ENV_HOME}/.git

USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["nub", "run", "verify:install"]
