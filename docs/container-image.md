# Container image artifact

## Image contract

Purpose: CI and toolchain artifact for pi-env. It can become a base for later homelab-agent composition.

State: built from [`Dockerfile`](../Dockerfile) and published by [`.github/workflows/image.yml`](../.github/workflows/image.yml).

Default command:

```bash
nub run verify:install
```

Verify the complete image artifact contract with one in-image command:

```bash
docker run --rm IMAGE nub run verify:image-artifact
```

The workflow does not sign or deploy.

The image stores generated dependency notices and license texts in `/opt/pi-env/THIRD_PARTY_LICENSES`.
It stores Alpine corresponding-source archives in `/opt/pi-env/THIRD_PARTY_SOURCES`.
See [licensing](licensing.md) for the artifact contract and package review policy.

The artifact includes Git for HTTPS workflows but not an SSH client. Downstream agent images that require SSH transport or SSH signing must add a client and own its security update policy.

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
