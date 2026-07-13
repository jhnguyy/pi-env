# Container image artifact

## Image contract

Purpose: CI/toolchain artifact for pi-env; possible base for later homelab-agent composition.

State: built from [`Dockerfile`](../Dockerfile) and published by [`.github/workflows/image.yml`](../.github/workflows/image.yml).

Default command:

```bash
nub run verify:install
```

The workflow does not sign or deploy.

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

## Source navigation

- Image recipe: [`Dockerfile`](../Dockerfile)
- Build/publish lane: [`.github/workflows/image.yml`](../.github/workflows/image.yml)
- Image scanning helpers: [`scripts/trivy-scan.sh`](../scripts/trivy-scan.sh), [`scripts/trivy-image-summary.mjs`](../scripts/trivy-image-summary.mjs)
