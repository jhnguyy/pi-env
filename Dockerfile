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
FROM ghcr.io/nubjs/nub:0.2.10-alpine@sha256:f3efdc86d557acfcdd18e25e1b4fb3dd1c6433e1a56cdb277b791df438e738aa AS pi-env

LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="pi-env CI/toolchain image artifact with locked Nub dependencies and prebuilt extension bundles"

ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

USER root
RUN apk upgrade --no-cache \
  && apk add --no-cache \
    bash \
    ca-certificates \
    git

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && node --version \
  && nub --version

WORKDIR ${PI_ENV_HOME}
COPY --chown=node:node . .
RUN chown -R node:node ${PI_ENV_HOME}

USER node

# Local equivalent: nub install --frozen-lockfile
RUN nub install --frozen-lockfile

# Local equivalent: nub run build
RUN nub run build

# Local equivalent: nub run verify
RUN nub run verify

USER root
RUN find /home/node/.cache/nub/node -path '*/lib/node_modules/npm' -prune -exec rm -rf {} + \
  && find /home/node/.cache/nub/node \( -name npm -o -name npx \) -type l -delete \
  && rm -rf /home/node/.cache/nub/pm/packuments-full-v1 \
  && rm -rf ${PI_ENV_HOME}/.git

USER node
CMD ["nub", "run", "verify:install"]
