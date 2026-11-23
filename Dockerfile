# syntax=docker/dockerfile:1.7

# Package the portable workbench without machine-local identity or state.
# CI runs verification in the Nix builder before qualifying this artifact.
# Docker builds themselves do not run tests.
# Debian's tmux predates the 3.8 baseline required by the tmux template.
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
    util-linux \
  && npm install --global --omit=dev "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/pi-env-package.json")).packageManager.replace("nub@", "@nubjs/nub@")')" \
  && nub --version \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && rm -rf /var/lib/apt/lists/* /tmp/pi-env-package.json \
  && node --version

COPY --from=tmux-build /usr/local/bin/tmux /usr/local/bin/tmux
RUN tmux -V

WORKDIR ${PI_ENV_HOME}

FROM toolchain AS dependencies

COPY --chown=node:node . .
RUN chown -R node:node ${PI_ENV_HOME}

USER node

# Keep Nub's content-addressed download store out of immutable image layers.
RUN --mount=type=cache,target=/home/node/.local/share/nub/store,uid=1000,gid=1000 \
  nub install --frozen-lockfile \
  && nub run licenses:generate \
    --package-root /usr/local/lib/node_modules \
    --system-license node-LICENSE.txt=/usr/local/LICENSE

FROM dependencies AS package
# The compiler sensor is needed for qualification, not the distributed workbench.
RUN find ${PI_ENV_HOME}/node_modules/.store \
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

# Excluded files must not survive in earlier distributed layers.
FROM toolchain AS pi-env
LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="pi-env CI/toolchain image artifact with locked Nub dependencies and prebuilt extension bundles" \
  org.opencontainers.image.source="https://github.com/jhnguyy/pi-env" \
  org.opencontainers.image.licenses="MIT"
COPY --from=package --chown=node:node /opt/pi-env /opt/pi-env
COPY --from=package --chown=node:node /home/node /home/node
USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["nub", "run", "verify:install"]
