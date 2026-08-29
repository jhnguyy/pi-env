# Licensing and third-party notices

pi-env is licensed under the MIT License. See [`LICENSE`](../LICENSE).

## Source-tree notices

[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) records third-party material that is part of the source tree. This includes ported source, patches, and color palettes.

Do not remove an upstream copyright notice, license header, or notice file. Add a source-tree notice when a change copies or modifies third-party material.

## JavaScript dependency policy

[`compliance/license-policy.json`](../compliance/license-policy.json) defines the allowed JavaScript license identifiers. It also records reviewed license-text overrides and source references.

Run this check after dependency installation:

```bash
nub run licenses:check
```

The check follows installed dependency links from the root package and declared workspaces into the Nub virtual store. It ignores stale virtual-store entries that no installed dependency tree can reach. It does not infer artifact contents only from `package.json` or `lock.yaml`.

A dependency update must fail the check when it:

- Adds a dependency without license metadata.
- Adds an unapproved license identifier.
- Adds a prohibited strong-copyleft license.
- Changes a package version that uses a reviewed license-text override.
- Removes the source reference for a package that requires source availability.

Review and update the policy only after you verify the new upstream terms and notice text. Source references use immutable revisions.

## Debian package policy

[`compliance/debian-policy.json`](../compliance/debian-policy.json) approves each installed Debian package and its source package. The image build rejects unapproved package or source mappings.

## Container artifact

The container build runs `nub run licenses:generate`. The command writes the artifact license bundle to `/opt/pi-env/THIRD_PARTY_LICENSES`.

The bundle contains:

- A deterministic JavaScript package manifest.
- The license and notice files from installed JavaScript packages.
- Reviewed fallback notices for packages that omit license files.
- Immutable corresponding-source references for MPL-covered JavaScript packages.
- The exact Debian binary and source package versions.
- The installed copyright file for every Debian binary package.
- Complete exact source artifacts for every installed Debian source package.
- The Node.js license from the pinned base image.

The image stores Debian source artifacts in `/opt/pi-env/THIRD_PARTY_SOURCES/debian`.

An SBOM does not replace these license and source artifacts.

## Nix outputs

The flake composes packages from Nixpkgs and Nub. Each package keeps its upstream license terms and Nix package metadata.

If pi-env publishes a Nix binary cache or exports a Nix closure, the publisher must also provide all required notices and corresponding source for that closure. A local user build does not make pi-env the binary distributor.
