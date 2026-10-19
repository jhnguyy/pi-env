# Nix

Use the [setup choices](../README.md#setup-choices) to select a provisioning mode.

[flake.nix](../flake.nix) declares inputs and public outputs. [flake.lock](../flake.lock) records input revisions. Read the [Nix implementation](../nix/) for package composition, runtime bindings, applications, and checks. The [manifest](../package.json) owns repository compatibility and dependency declarations.

The [toolchain](../nix/toolchain.nix) applies the [Nub GVS lock-access patch](../nix/patches/nub-gvs-lock-read-access.patch) and [store lock-access patch](../nix/patches/nub-store-lock-read-access.patch) through Nub's existing package recipe. Portable setup does not apply Nix source patches.

## Packages and ownership

`packages.<system>.tools` (`nix build .#tools`) supplies Node, patched Nub, and the baseline command-line tools without Pi. It reuses the [toolchain composition](../nix/toolchain.nix), including Nub's upstream recipe and local patches. External consumers can pin this package separately from the application checkout. See [external runtime setup](setup.md#externally-managed-tools-with-checkout-owned-pi) for the environment and lifecycle contract.

`packages.<system>.toolchain` and the default package still include upstream Nix-packaged Pi. Local setup apps, the development shell, and Home Manager retain their Nix Pi bindings.

## Home Manager

Use the exported Home Manager module for declarative host integration. Read its [option declarations and configuration](../nix/home-manager.nix) when configuring a consumer. Do not copy defaults from this documentation.

Host profile activation, builder access, and binary-cache trust belong in the consuming infrastructure. Use the [setup option owner](../setup/options.sh) for explicit Home Manager synchronization controls.

## Validation

Inspect outputs with `nix flake show`. Run `nix flake check` to build Pi and run its upstream install checks, plus the setup checks. Use `nix build .#pi --no-link` for a focused Pi package check. Use `nix build .#tools --no-link` to check the tools-only package. Run the [repository verification portfolio](../scripts/verification-phases.mjs) for dependency-backed workflows.

Use isolated homes and agent directories for setup validation. Do not activate a live host profile or reset live settings to validate a contribution.
