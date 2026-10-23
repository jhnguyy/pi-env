# Nix

Use the [setup choices](../README.md#setup-choices) to select a provisioning mode.

[flake.nix](../flake.nix) declares inputs and public outputs. [flake.lock](../flake.lock) records input revisions. Read the [Nix implementation](../nix/) for package composition, runtime bindings, applications, and checks. The [manifest](../package.json) owns repository compatibility and dependency declarations.

The [toolchain](../nix/toolchain.nix) applies the [Nub GVS lock-access patch](../nix/patches/nub-gvs-lock-read-access.patch) and [store lock-access patch](../nix/patches/nub-store-lock-read-access.patch) through Nub's existing package recipe. Portable setup does not apply Nix source patches.

## Packages and ownership

`packages.<system>.tools` (`nix build .#tools`) supplies Node, Nub, and the baseline command-line tools without Pi. External consumers can pin this package separately from the application checkout. See [external runtime setup](setup.md#externally-managed-tools-with-checkout-owned-pi) for the environment and lifecycle contract.

`packages.<system>.toolchain` and the default package still include upstream Nix-packaged Pi. Local setup apps, the development shell, and Home Manager retain their Nix Pi bindings.

## Pi release review

Keep the Pi flake input and matching development packages on the same version. The [release collector](../scripts/collect-pi-release-evidence.mjs) collects version-checked documents from local upstream source without changing that source or live settings:

```bash
node scripts/collect-pi-release-evidence.mjs \
  --source-dir /path/to/pi \
  --old-version X.Y.Z \
  --new-version X.Y.Z \
  --output-dir /path/to/new-output
```

## Local command-override patch

Pi-env carries a core dispatcher hook for explicit built-in command ownership. Nix applies the source patch before Pi's normal build. Nub applies a versioned package patch during dependency installation, including SDK JavaScript, declarations, and the bundled CLI. Neither path changes an installed editor or rewrites runtime methods after startup.

Review the source patch for behavior. Treat the package patch as a generated artifact. The [generator](../scripts/generate-pi-command-override-patches.mjs) checks the pinned source revision and published package version, and rejects unrelated bundle changes. It uses Pi's official build output rather than a separate bundler configuration.

To regenerate, apply the source patch to the locked Pi checkout and follow that checkout's build instructions. Mark the new suite test as intent-to-add so its diff is included. Then provide the built checkout and an unpacked pristine published package:

```bash
node scripts/generate-pi-command-override-patches.mjs /path/to/built-pi /path/to/pristine-package
nub install --ignore-scripts --lockfile-only
nub install --frozen-lockfile
```

Keep both artifacts and the lockfile update together. Remove the local patches when the dependency supplies the required hook itself. An externally managed Pi must be rebuilt by its provisioner; setup verifies its capability instead of modifying it. Restart Pi after changing the core runtime.

## Home Manager

Use the exported Home Manager module for declarative host integration. Read its [option declarations and configuration](../nix/home-manager.nix) when configuring a consumer. Do not copy defaults from this documentation.

Host profile activation, builder access, and binary-cache trust belong in the consuming infrastructure. Use the [setup option owner](../setup/options.sh) for explicit Home Manager synchronization controls.

## Validation

Inspect outputs with `nix flake show`. Run `nix flake check` to build Pi and run its upstream install checks, plus the setup checks. Use `nix build .#pi --no-link` for a focused Pi package check. Use `nix build .#tools --no-link` to check the tools-only package. Run the [repository verification portfolio](../scripts/verification-phases.mjs) for dependency-backed workflows.

Use isolated homes and agent directories for setup validation. Do not activate a live host profile or reset live settings to validate a contribution.
