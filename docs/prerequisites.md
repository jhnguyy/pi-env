# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup runs one frozen dependency installation and reports its result. It does not delete `node_modules` or retry after an installation failure.

Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned configuration and scripts live in [`package.json`](../package.json), [`nub.jsonc`](../nub.jsonc), [`flake.nix`](../flake.nix), and [`setup/`](../setup).

## Nub admission and portable recovery

Before discovering Node or invoking Nub in the checkout, setup probes the PATH
Nub executable with `--version` from `/` and requires the **exact**
`package.json#packageManager` pin (currently `nub@0.9.2`, not the `devEngines`
range). Missing tools, failed probes, malformed output, and older or newer
versions stop setup without deleting dependencies or retrying installation.
Setup's direct Nub calls reuse the admitted executable path; package lifecycle
scripts still inherit PATH. Admission checks compatibility, not executable
provenance, and cannot protect against replacement of that file during setup.

Setup does **not** upgrade Nub on this or other machines. If automatic Nix
setup fails, setup stops. It does not retry against PATH tools. Use `--portable`
only when the PATH toolchain is suitable. In a Nix-managed machine,
update/re-enter the repository's pinned Nix environment (`nix run .#setup`),
or ask the Home Manager/container owner to reprovision it. Setup does not
modify the managed toolchain.

On a portable machine, retain `node_modules` and local configuration. Provision
the exact pinned Nub using a trusted, independently verified distribution and
its supported Node/runtime, outside setup; place that private installation's
bin directory first on PATH, check `nub --version` outside the checkout, then
rerun `./setup.sh --portable`. If you cannot verify a portable distribution,
use the pinned Nix route instead. Do not work around admission by changing the
manifest, deleting dependencies, or running an unverified install script.

An opt-in private portable bootstrap remains a separate design: this repository
pins Nub's Nix source, but does not specify a verified portable release artifact
with per-platform checksums/signatures and a supported bootstrap runtime. A Nix
source hash is not verification of a portable binary or npm tarball. Before
adding such an option we need that artifact/runtime contract, verification
before execution, script-free extraction, private atomic installation and
rollback, and tests proving no system/global writes. No download/bootstrap flag
is provided rather than silently falling back to unverified downloads or package
lifecycle scripts.
