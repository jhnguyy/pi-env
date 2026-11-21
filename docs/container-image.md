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

See [licensing](licensing.md) for the artifact contract.

## CI results and failure evidence

The Actions summary separates full verification from image assembly, artifact checks, and security policy. Download `image-evidence` for phase durations/outcomes, toolchain versions, JUnit reports from completed test phases, and the sanitized image scan. Reports remain available for seven days when produced, including on failure. JUnit excludes captured console streams but retains assertion diagnostics; setup reports retain only bounded explicit `FAIL:` messages, not raw output. Scanner evidence excludes secret matches and source snippets. Setup/provisioning failures and abrupt runner termination may prevent report generation; missing evidence is not a pass.

Verification runs fail-fast. Later phases marked `not-run` have no qualification. Security success means no findings that block under the current policy, not zero vulnerabilities; summaries report unfixed HIGH/CRITICAL findings separately.

To export verification evidence locally with Docker/Buildx available:

```bash
docker buildx bake reports
node scripts/ci-report.mjs verification .e2e-evidence/verification
```

The `reports` target deliberately exports evidence even when tests fail. Its successful export is **not** successful verification: the second command checks the recorded outcome. Use `docker buildx bake image` for interactive image builds: both `image` and `reports` rerun verification rather than reuse cached test outcomes. The final Dockerfile stage independently rejects a failed verification before producing the image. CI uses the internal `candidate` target only after accepting fresh reports, reusing the same job-local verification layers, then checks/scans the image before publication. Direct Dockerfile builds use normal layer caching; pass `--no-cache-filter verification` when fresh qualification is required. The publisher summary gives the digest-pinned pull reference.

The stock-runner lane retains setup JUnit as `portable-setup-evidence`. The separate Trivy source workflow retains its dependency inventory and policy report as `trivy-filesystem-reports` for seven days. Its summary distinguishes policy findings from scanner failures.

The artifact includes Git for HTTPS workflows but not an SSH client. Downstream agent images that require SSH transport or SSH signing must add a client and own its security update policy.

## State and secrets

Image-owned:

- `/opt/pi-env`
- installed Nub/Node toolchain
- dependency and extension build outputs

External runtime state:

- GitHub auth and SSH signing keys
- Git identity/signing config
- pi sessions, auth, model credentials, settings, local overrides
- homelab notes
- runtime worktrees/deployment config

Do not bake secrets or mutable agent state into the image.

## Source navigation

- Image recipe: [`Dockerfile`](../Dockerfile)
- Build/publish lane: [`.github/workflows/image.yml`](../.github/workflows/image.yml)
- Image scanning helpers: [`scripts/trivy-scan.sh`](../scripts/trivy-scan.sh), [`scripts/trivy-image-summary.mjs`](../scripts/trivy-image-summary.mjs)
