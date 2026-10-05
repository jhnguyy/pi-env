# Nix

Use the [setup choices](../README.md#setup-choices) to select a provisioning mode.

[flake.nix](../flake.nix) declares inputs and public outputs. [flake.lock](../flake.lock) records input revisions. Read the [Nix implementation](../nix/) for package composition, runtime bindings, applications, and checks. The [manifest](../package.json) owns repository compatibility and dependency declarations.

## Home Manager

Use the exported Home Manager module for declarative host integration. Read its [option declarations and configuration](../nix/home-manager.nix) when configuring a consumer. Do not copy defaults from this documentation.

Host profile activation, builder access, and binary-cache trust belong in the consuming infrastructure. Use the [setup option owner](../setup/options.sh) for explicit Home Manager synchronization controls.

## Validation

Inspect outputs with `nix flake show`. Run `nix flake check` for flake checks and the [repository verification portfolio](../scripts/verification-phases.mjs) for dependency-backed workflows.

Use isolated homes and agent directories for setup validation. Do not activate a live host profile or reset live settings to validate a contribution.
