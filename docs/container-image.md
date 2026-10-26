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

Qualification and publication use separate runners so candidate execution and scanning do not share publication permissions. The qualified image crosses that boundary as a Docker archive. The publisher checks the archive SHA-256 and loaded image ID against qualification outputs before registry authentication. It does not rebuild or execute the image.

The [image workflow](../.github/workflows/image.yml) owns event restrictions, artifact retention, and registry tags. See the [scanner trust boundary](../SECURITY.md) for remaining risks.

GitHub run names distinguish pull-request verification from `main` publication. Step names and failure annotations identify the build, artifact contract, security scanner, security policy, candidate identity, authentication, or registry publication boundary.

The workflow does not sign or deploy.

See [licensing](licensing.md) for the artifact contract.

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
