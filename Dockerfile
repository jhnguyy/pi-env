# syntax=docker/dockerfile:1.7

# Load the flake's builder-image and runtime-image before invoking Bake.
# The final target consumes the separately built verification image: it cannot
# silently reinstall dependencies or rebuild bundles if build caches disappear.
ARG BUILDER_IMAGE=pi-env-builder:ci
ARG COMPONENTS_IMAGE=pi-env:verification
ARG RUNTIME_IMAGE=pi-env-runtime:ci

FROM ${BUILDER_IMAGE} AS verification
ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  HOME=/home/agent
WORKDIR ${PI_ENV_HOME}
COPY --chown=1000:1000 . .
RUN chown -R 1000:1000 ${PI_ENV_HOME}
USER 1000:1000

# Nub's postinstall hydrates the extension bundles. Qualification uses --prebuilt
# so it tests these outputs rather than replacing them in a writable container.
RUN --mount=type=cache,target=/home/agent/.local/share/nub/store,uid=1000,gid=1000 \
  nub install --frozen-lockfile \
  && nub run licenses:generate \
    --system-license node-LICENSE.txt=/usr/share/licenses/nodejs/LICENSE

FROM ${COMPONENTS_IMAGE} AS package
# Qualification-only compiler binaries and build metadata are not distributed.
RUN find /opt/pi-env/node_modules/.store \
    -path '*/node_modules/@oxlint-tsgolint/*/tsgolint' -type f -delete \
  && rm -rf /opt/pi-env/.git \
    /home/agent/.local/share/nub/store \
    /home/agent/.cache/nub/pm/packuments-full-v1

FROM ${RUNTIME_IMAGE} AS pi-env
ENV PI_ENV_HOME=/opt/pi-env \
  PI_ENV_CONTAINER=1 \
  HOME=/home/agent
WORKDIR ${PI_ENV_HOME}
LABEL org.opencontainers.image.title="pi-env" \
  org.opencontainers.image.description="Nix-based pi-env workbench with qualified dependencies and prebuilt extension bundles" \
  org.opencontainers.image.source="https://github.com/jhnguyy/pi-env" \
  org.opencontainers.image.licenses="MIT"
COPY --from=package --chown=1000:1000 /opt/pi-env /opt/pi-env
COPY --from=package --chown=1000:1000 /home/agent /home/agent
USER 1000:1000
ENTRYPOINT ["tini", "--"]
CMD ["nub", "run", "verify:install"]
