# Container image artifact

## Local/source build

```bash
nub install --frozen-lockfile
nub run build
nub run verify
```

The Dockerfile mirrors these commands:

| Dockerfile step | Local command |
| --- | --- |
| Install locked dependencies | `nub install --frozen-lockfile` |
| Build extension bundles | `nub run build` |
| Verify repo | `nub run verify` |

## Image contract

Purpose: CI/toolchain artifact for pi-env; possible base for later homelab-agent composition.

Contains:

- official digest-pinned `ghcr.io/nubjs/nub:0.2.10-slim` with npm removed from global and cached Node installs
- `git`, `openssh-client`, CA certificates
- source under `/opt/pi-env`
- locked dependencies from `lock.yaml`
- prebuilt `.pi/extensions/*/dist`
- Node resolved by Nub from `package.json#devEngines.runtime` / `.node-version`

Default command:

```bash
nub run verify:install
```

Build-only `.git` metadata is removed from the final image after `nub run verify`.

## State and secrets

Image-owned:

- `/opt/pi-env`
- installed Nub/Node toolchain
- dependency and extension build outputs

External runtime state:

- GitHub auth and SSH signing keys
- Git identity/signing config
- pi sessions, handoffs, auth, model credentials, settings, local overrides
- homelab notes
- runtime worktrees/deployment config

Do not bake secrets or mutable agent state into the image.

## CI lane

`.github/workflows/image.yml`:

- PRs: build locally, smoke-test, and scan the built image with a compact Trivy summary; no publish.
- `main`: build locally, smoke-test, scan, then publish to GHCR as `:main` and `:<sha>`.

The workflow does not sign or deploy.
