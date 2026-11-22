# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS node-runtime

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS ci-base

# Shared prerequisites only. Provisioning checks must still install Nub and Nix.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    libatomic1 \
    libstdc++6 \
    sudo \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash ci

# Copy the runtime and its notice, not npm, Yarn, headers, or the source image layers.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/LICENSE /usr/share/doc/nodejs/LICENSE

LABEL org.opencontainers.image.title="pi-env provisioning base" \
  org.opencontainers.image.description="Minimal prerequisites for clean portable and Nix CI provisioning" \
  org.opencontainers.image.source="https://github.com/jhnguyy/pi-env"

# Provisioning jobs explicitly request root when installing their own toolchain.
USER ci
CMD ["bash"]
