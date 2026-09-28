#!/usr/bin/env bash
# Portable, opt-in bootstrap. Release bytes are pinned here independently of
# the release's downloadable checksum file; never execute an unchecked archive.
setup_bootstrap_nub() {
  [ "${PI_ENV_BOOTSTRAP_NUB:-0}" = 1 ] || return 0
  if [ "${PI_ENV_CONFIG_MANAGED_BY_NIX_AT_ENTRY:-0}" = 1 ]; then
    echo 'pi-env: Nub bootstrap is unavailable in a Nix-managed environment. Reprovision the managed toolchain.' >&2
    return 1
  fi

  local line pin='' count=0 version='' platform archive digest current tmp
  local pin_pattern='^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"nub@([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*,?[[:space:]]*$'
  while IFS= read -r line; do
    if [[ "$line" =~ $pin_pattern ]]; then
      pin="${BASH_REMATCH[1]}"
      count=$((count + 1))
    fi
  done < "$REPO/package.json"
  if [ "$count" -ne 1 ]; then
    echo 'pi-env: expected one exact Nub pin in package.json#packageManager; bootstrap stopped.' >&2
    return 1
  fi
  current=$(type -P nub || true)
  if [ -n "$current" ]; then
    version=$(cd / && "$current" --version 2>/dev/null | head -n 1) || version=''
  fi
  if [ "$version" = "v$pin" ]; then
    return 0
  fi

  # Only releases whose archive digest was reviewed and committed can bootstrap.
  case "$pin:$(uname -s):$(uname -m)" in
    0.9.5:Linux:x86_64) platform=linux-x64; digest=f1f21f6365c454ec820cee5ad3ce9b014d4ce9bebf22390200d390e53693ecdf ;;
    0.9.5:Linux:aarch64) platform=linux-arm64; digest=e6c0dace69682819f2cdbd8a3403e8d3e10ebc8e3ae8110cc2ec776c60c218e8 ;;
    0.9.5:Darwin:x86_64) platform=darwin-x64; digest=a628e7afae5f4ad0f201e8377ee94136e4784f6db3110199690fb737c6f89330 ;;
    0.9.5:Darwin:arm64) platform=darwin-arm64; digest=b601d669a8e971eaa958942bdde4e310496ca0b5da7fb113406bc1b4703f2847 ;;
    *) echo "pi-env: no verified portable Nub archive for $pin on $(uname -s)/$(uname -m); bootstrap stopped." >&2; return 1 ;;
  esac
  command -v curl >/dev/null && command -v tar >/dev/null || {
    echo 'pi-env: portable Nub bootstrap requires curl and tar.' >&2; return 1;
  }
  if ! command -v sha256sum >/dev/null && ! command -v shasum >/dev/null; then
    echo 'pi-env: portable Nub bootstrap requires sha256sum or shasum.' >&2
    return 1
  fi
  tmp=$(mktemp -d) || return 1
  PI_ENV_NUB_TMP="$tmp"
  # Clean up even if dependency installation fails. Do not edit host PATH files.
  trap 'rm -rf -- "$PI_ENV_NUB_TMP"' EXIT
  archive="$tmp/nub.tar.gz"
  echo "pi-env: PATH Nub is ${version:-missing} (requires v$pin); downloading verified temporary Nub for $platform."
  if ! curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLsS --retry 2 --max-time 120 \
    -o "$archive" "https://github.com/nubjs/nub/releases/download/v$pin/nub-$platform.tar.gz"; then
    echo 'pi-env: Nub download failed; existing dependencies were not changed.' >&2
    return 1
  fi
  local actual
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$archive")
  else
    actual=$(shasum -a 256 "$archive")
  fi
  if [ "${actual%% *}" != "$digest" ]; then
    echo 'pi-env: Nub archive checksum mismatch; refusing to extract or execute it.' >&2
    return 1
  fi
  mkdir -m 700 "$tmp/bin"
  if ! tar -xzf "$archive" -C "$tmp/bin" --strip-components=1 bin/nub; then
    echo 'pi-env: Nub archive extraction failed.' >&2
    return 1
  fi
  if [ ! -f "$tmp/bin/nub" ] || [ -L "$tmp/bin/nub" ] || [ ! -x "$tmp/bin/nub" ]; then
    echo 'pi-env: Nub archive has no executable bin/nub.' >&2
    return 1
  fi
  if ! version=$(cd / && "$tmp/bin/nub" --version 2>/dev/null | head -n 1) || [ "$version" != "v$pin" ]; then
    echo "pi-env: verified Nub binary cannot run or reports ${version:-no version}; use a supported host runtime or Nix toolchain." >&2
    return 1
  fi
  export PATH="$tmp/bin:$PATH"
  echo "pi-env: using verified temporary Nub v$pin; no global toolchain was changed."
}
