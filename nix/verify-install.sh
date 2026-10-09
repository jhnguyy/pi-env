#!/usr/bin/env bash
if [ ! -f ./package.json ]; then
  echo "Run the Nix verification app from a pi-env checkout." >&2
  exit 2
fi

export PI_ENV_REPO="$PWD"
exec nub run verify:install
