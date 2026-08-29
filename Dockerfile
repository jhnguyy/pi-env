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
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS pi-env

LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="pi-env CI/toolchain image artifact with locked Nub dependencies and prebuilt extension bundles" \
  org.opencontainers.image.source="https://github.com/jhnguyy/pi-env" \
  org.opencontainers.image.licenses="MIT"

ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

USER root
RUN sed -i \
    -e 's/^Types: deb$/Types: deb deb-src/' \
    -e 's|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20260824T000000Z|' \
    -e 's|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20260824T000000Z|' \
    /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    tini \
  && npm install --global --omit=dev @nubjs/nub@0.2.10 \
  && nub --version \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && node --version

WORKDIR ${PI_ENV_HOME}
COPY --chown=node:node . .
RUN chown -R node:node ${PI_ENV_HOME} \
  && dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' \
    > /tmp/pi-env-dpkg-query \
  && node scripts/generate-debian-source-bundle.mjs \
    --dpkg-query /tmp/pi-env-dpkg-query \
    --output ${PI_ENV_HOME}/THIRD_PARTY_SOURCES/debian

USER node

# Local equivalent: nub install --frozen-lockfile
RUN nub install --frozen-lockfile

# Preserve package notices, Debian copyright files, and exact source artifacts.
RUN nub run licenses:generate \
  --package-root /usr/local/lib/node_modules \
  --dpkg-query /tmp/pi-env-dpkg-query \
  --debian-source-manifest ${PI_ENV_HOME}/THIRD_PARTY_SOURCES/debian/manifest.json \
  --system-license node-LICENSE.txt=/usr/local/LICENSE

# Local equivalent: nub run build
RUN nub run build

# BuildKit does not run the image entrypoint, so Tini must reap detached test descendants here.
RUN tini -s -- nub run verify

USER root
RUN find /home/node/.cache/nub/node -path '*/lib/node_modules/npm' -prune -exec rm -rf {} + \
  && find /home/node/.cache/nub/node \( -name npm -o -name npx \) -type l -delete \
  && rm -rf /home/node/.cache/nub/pm/packuments-full-v1 \
  && rm -rf /var/lib/apt/lists/* /tmp/pi-env-dpkg-query ${PI_ENV_HOME}/.git

USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["nub", "run", "verify:install"]
