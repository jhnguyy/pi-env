---
name: pi-update
description: Collects audited local Pi release evidence and guides a pi-env Pi dependency update. Use when reviewing or updating the pinned Pi flake input and matching development dependencies.
---

# Pi update

Use this skill for `/skill:pi-update`. Do not use the retired `pi-update` extension.

1. Read the repository contribution policy. Delegate worktree creation, validation, review, commit, and publishing to `code-contribution`.
2. Locate the selected upstream Pi source resolved by the flake, or an explicitly acquired local source. Delegate source acquisition to the contribution workflow. Collection does not fetch or install anything.
3. Run the collector from this skill directory:

   ```bash
   node scripts/collect-release-evidence.mjs \
     --source-dir /path/to/pi \
     --old-version X.Y.Z \
     --new-version X.Y.Z \
     --output-dir /path/to/empty-output
   ```

   The collector validates the target package version, both changelog boundaries, and separate source/output paths. It refuses an existing output directory. On failure it removes only its partial output directory. The output contains source identity, hashes, the relevant full documents, and the exact changelog range headings.
4. Review the collected documents, release range, and update checklist before changing dependencies. Keep the Pi flake input pinned to the selected version. Update matching development dependencies to that exact version. If Nub is the fallback, use the same exact version.
5. Check package exports/imports, extension lifecycle APIs, settings and trust, package/resource discovery, CLI consumers, Nix packaging, and user-visible behavior against the whole release range. Do not add a custom enablement toggle. Report compatibility decisions and user-visible changes.
6. Use `code-contribution` for validation and any publish action. Do not commit, push, merge, deploy, or alter user settings unless explicitly requested.

The collector has no network, Git mutation, settings mutation, package installation, worktree, synchronization, dispatch, or executable-install behavior.

## Collection evidence

The source can be an upstream checkout with `packages/coding-agent/`, or the coding-agent package directory. For a local fixture, include `package.json`, `CHANGELOG.md`, `README.md`, and the documented files under `docs/`. Run the command above and inspect `metadata.json`, `CHANGELOG.md`, and `evidence.md`. A successful run creates only the requested output directory and leaves the repository and settings unchanged.

For failure evidence, run the command with an already existing `--output-dir`. It exits nonzero, reports that the output directory exists, and does not modify that directory.
