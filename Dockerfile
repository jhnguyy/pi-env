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
FROM ghcr.io/nubjs/nub:0.2.10-slim@sha256:b2a979e5ace8dd31d0f352aff1b3a2967ef7100f4d398ab61a77122e3fbd7425 AS pi-env

LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="pi-env CI/toolchain image artifact with locked Nub dependencies and prebuilt extension bundles"

ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

USER root
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

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
