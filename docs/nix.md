# Nix

Use the [setup choices](../README.md#setup-choices) to select a provisioning mode.

[flake.nix](../flake.nix) declares inputs and public outputs. [flake.lock](../flake.lock) records input revisions. Read the [Nix implementation](../nix/) for package composition, runtime bindings, applications, and checks. The [manifest](../package.json) owns repository compatibility and dependency declarations.

## Packages and ownership

Nix owns the runtime tools; Pi can either come from Nix or an independently updated application checkout. Use the tools-only package for the latter and follow the [external runtime setup contract](setup.md#externally-managed-tools-with-checkout-owned-pi). Local setup, development shells, and Home Manager retain Nix-packaged Pi.

## Pi release review

Keep the Pi flake input and matching development packages on the same version. The [release collector](../scripts/collect-pi-release-evidence.mjs) collects version-checked documents from local upstream source without changing that source or live settings:

```bash
node scripts/collect-pi-release-evidence.mjs \
  --source-dir /path/to/pi \
  --old-version X.Y.Z \
  --new-version X.Y.Z \
  --output-dir /path/to/new-output
```

## Home Manager

Use the exported Home Manager module for declarative host integration. Read its [option declarations and configuration](../nix/home-manager.nix) when configuring a consumer. Do not copy defaults from this documentation.

Host profile activation, builder access, and binary-cache trust belong in the consuming infrastructure. Use the [setup option owner](../setup/options.sh) for explicit Home Manager synchronization controls.

## Validation

Inspect available outputs with `nix flake show` and run `nix flake check` for package and setup checks. Run the [repository verification portfolio](../scripts/verification-phases.mjs) for dependency-backed workflows.

Use isolated homes and agent directories for setup validation. Do not activate a live host profile or reset live settings to validate a contribution.
