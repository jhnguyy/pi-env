# Setup improvement backlog

This repo should stay biased toward deletion and convergence. The setup layer is allowed to be pragmatic, but each compatibility branch should have a reason to exist and a path to removal.

## Near-term cleanup

- **Collapse setup modes after host rollout.** Once `homelab-agent` and daily-driver both export `PI_ENV_CONFIG_MANAGED_BY_NIX=1`, reevaluate whether `--nix-managed` needs to remain user-facing or can become an internal compatibility switch.
- **Remove plain-Node Nub workaround when upstream/runtime is fixed.** The `nub install --ignore-scripts` path exists for runtimes where Nub's augmented Node cannot execute but plain Node can. Track whether this is still needed after the homelab agent base image/toolchain is refreshed.
- **Keep README, `setup/nix.md`, and `setup/prerequisites.md` aligned.** Setup mode drift is easy; each behavior change should update all three or intentionally delete overlap.
- **Retire stale package-manager language.** Old npm/Bun references should not survive once Nub is the only JavaScript dependency manager.

## Structural pressure

- **Prefer fewer entrypoints.** Plain `./setup.sh` should remain the happy path. Flags are escape hatches, not primary docs.
- **Prefer probes over environment folklore.** Setup should test whether a runtime works instead of assuming a VM/container/Nix label implies behavior.
- **Do not duplicate host management.** If Home Manager owns a file, setup should report and skip; if setup owns a file, Home Manager should not also render it.
- **Name every compatibility branch.** If code handles a weird environment, the log message and this backlog should explain why.

## Review checklist for setup changes

- Did this add another branch? What old branch can be removed?
- Can this be represented as a runtime probe instead of a new flag?
- Does the common path stay readable from top to bottom?
- Are mutable user files protected from overwrite?
- Did validation include both setup unit tests and a fresh-ish `./setup.sh` run?
