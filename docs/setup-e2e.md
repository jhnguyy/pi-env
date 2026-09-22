# Setup configuration E2E pilot

## Claim and boundary

The pilot runs the real `setup/configure.mjs pi` CLI twice against one disposable home. It uses the checkout's installed dependencies and real configuration code without mocks.

It proves that this configuration workflow:

- Preserves synthetic auth, user settings, and local guidance before and after the managed region
- Reconciles managed guidance and settings from their owning sources
- Registers the package once and appends the repository instruction payload once
- Creates the expected test-utility symlinks
- Leaves the selected configuration files byte-identical on the second run

The fixture selects `nix-managed` policy. The Pi configuration operation is shared across modes, so this is not evidence of mode-specific policy gating.

The pilot does not invoke `setup.sh`, install dependencies, load extensions, contact a model provider, restart a daemon, or configure terminal files and Git hooks. Existing setup, runtime, packaging, and install checks retain those responsibilities. Existing narrower settings rollback, malformed-input, ownership, and runtime-selection tests remain in the portfolio.

## Run and inspect

Use the repository's required Node runtime and an initialized worktree. From the repository root:

```bash
bash setup/__tests__/configuration.e2e.test.sh
```

The command prints its artifact directory and returns nonzero for failed assertions, failed commands, or incomplete capture. It is also part of `nub run test:setup`, which already blocks both canonical verification portfolios.

Each run creates a unique directory under `.artifacts/setup-configuration/`. Set `PI_ENV_E2E_ARTIFACT_DIR` to select a different parent directory. Generated evidence is ignored by Git.

Verify saved evidence without running setup again:

```bash
bash setup/__tests__/configuration.e2e.test.sh --verify <artifact-directory>
```

The verifier recomputes assertions from the saved snapshots. It also checks snapshot hashes. It does not trust the verdict in `observations.json`. Use the scenario code at the recorded revision when verifying older evidence.

## Evidence and privacy

- `manifest.json` records revision, dirty state, tracked diff hash, scenario hash, fixture hash, runtime, commands, process results, and capture completeness.
- `seed.json` records synthetic inputs. The auth sentinel is represented only by its hash.
- `expected.json` records the scenario's expected user values and managed source content.
- `run-1.json` and `run-2.json` contain selected configuration products, raw-file hashes, auth hashes, and symlink targets.
- `observations.json` contains expected and actual values with assertion verdicts, or an incomplete-evidence failure.
- Per-run stdout and stderr logs contain bounded diagnostic output.

The registered package path is normalized to `<PACKAGE>`. Symlink targets and diagnostic paths use `<REPO>`, `<PACKAGE>`, and `<FIXTURE>` placeholders. File hashes refer to the original fixture bytes. Only the synthetic fixture is read for user configuration. The child receives an explicit environment rather than the caller's credentials or settings paths.

Each input snapshot file and captured output stream is limited to 64 KiB. Exceeding the subprocess capture limit fails the run. Missing, non-regular, or oversized snapshot inputs produce incomplete evidence. The disposable home is removed after the run. Saved partial artifacts remain for diagnosis. Abrupt process termination or storage failure can prevent finalization; evidence-only verification rejects missing products.

Hashes detect changes, not authenticity. A dirty revision and diff hash do not contain enough source to reconstruct an uncommitted change. For shareable reproduction evidence, commit the scenario and rerun from the recorded clean revision.

Local artifacts remain until the operator deletes the selected run directory after review. CI retains the artifact bundle for seven days, including failed runs. Inspect artifacts before sharing them.

## Counterfactual evidence

To check the assertion boundary without changing production code:

1. Copy a successful artifact directory to a new directory.
2. Duplicate the managed AGENTS block in the copied `run-2.json` snapshot.
3. Run the evidence-only verifier against the copy.
4. Confirm that managed-block cardinality and second-run stability fail, not only the integrity hash.

The successful original must still verify. This negative control tests the observable-result oracle. It does not replace defect injection into production code when a higher-risk capability needs that evidence.

The repository APPEND source currently contains its own marker, and setup adds an outer marker. The pilot checks one complete source payload, not a single marker occurrence. It does not change that existing setup behavior.
