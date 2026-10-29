#!/usr/bin/env sh
# Build the tmux release that setup/templates/tmux.conf targets on Debian-based hosts,
# whose packages predate it. Run as root. Nix hosts get tmux from nixpkgs instead.
set -eu

version=3.8
sha256=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
prefix=${PREFIX:-/usr/local}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  bison \
  ca-certificates \
  curl \
  gcc \
  libc6-dev \
  libevent-dev \
  libncurses-dev \
  make \
  pkg-config

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/tmux.tar.gz" \
  "https://github.com/tmux/tmux/releases/download/${version}/tmux-${version}.tar.gz"
echo "${sha256}  $work/tmux.tar.gz" | sha256sum -c -
tar -xzf "$work/tmux.tar.gz" -C "$work"
(cd "$work/tmux-${version}" && ./configure --prefix="$prefix" && make -j"$(nproc)" && make install)
"$prefix/bin/tmux" -V
