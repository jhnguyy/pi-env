#!/usr/bin/env bash
# Admission must run before Node discovery: even `nub node which` reads repo
# configuration. Use only Bash here, not Node or installed JS dependencies.
setup_admit_nub() {
  local line pin='' count=0 nub_bin version
  local pin_pattern='^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"nub@([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*,?[[:space:]]*$'
  # Deliberately fail closed if the source-owned manifest stops using the
  # canonical standalone exact-pin field. Do not substitute devEngines ranges.
  while IFS= read -r line; do
    if [[ "$line" =~ $pin_pattern ]]; then
      pin="${BASH_REMATCH[1]}"
      count=$((count + 1))
    fi
  done < "$REPO/package.json"
  if [ "$count" -ne 1 ]; then
    echo 'pi-env: expected one exact nub@X.Y.Z pin in package.json#packageManager; restore the manifest. See docs/prerequisites.md.' >&2
    return 1
  fi

  # Ignore inherited admission metadata and resolve an actual executable, not
  # a shell function/alias. Anchor relative PATH entries before leaving cwd.
  unset PI_ENV_NUB_BIN
  nub_bin=$(type -P nub) || nub_bin=''
  if [ -n "$nub_bin" ]; then
    case "$nub_bin" in /*) ;; *) nub_bin="$PWD/$nub_bin" ;; esac
  fi
  version='missing'
  if [ -n "$nub_bin" ] && [ -x "$nub_bin" ]; then
    if ! version=$(cd / && "$nub_bin" --version 2>/dev/null); then
      version='version probe failed'
    fi
  fi
  # Nub v0.9.2 prints vX.Y.Z on stdout; Node provenance is on stderr.
  if [ "${version#v}" != "$pin" ]; then
    printf 'pi-env: Nub admission failed: package.json#packageManager requires nub@%s; found %q (%s).\n' "$pin" "$version" "${nub_bin:-not on PATH}" >&2
    echo 'pi-env: no dependency cleanup, retry, or toolchain upgrade was attempted.' >&2
    echo 'pi-env: use nix run .#setup, or have your Nix/Home Manager owner reprovision the pinned toolchain. Portable recovery: docs/prerequisites.md.' >&2
    return 1
  fi
  PI_ENV_NUB_BIN="$nub_bin"
  SETUP_NUB_VERSION="$pin"
  export PI_ENV_NUB_BIN
}
