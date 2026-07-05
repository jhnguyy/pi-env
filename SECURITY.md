# Security scanning

This repository runs Trivy only after changes land on `main`:

- trigger: `push`, with the scan job guarded by `github.ref == 'refs/heads/main'`; branch pushes may create a skipped workflow record, but Trivy only executes after changes land on `main`
- permissions: read-only `contents`
- checkout: `actions/checkout` pinned by commit SHA with `persist-credentials: false`, so the repository token is not persisted into the workspace
- scanner: Trivy 0.70.0 as the job container, pinned by image digest (`aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e`), not `aquasecurity/trivy-action`
- container hardening: read-only container filesystem, dropped Linux capabilities, `no-new-privileges`, and a tmpfs-backed writable cache path

GitHub Actions standard hosted runners are free for public repositories, so the workflow favors GitHub-hosted `ubuntu-latest` over local runner maintenance.

Local testing uses the companion script:

```bash
bun run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
TRIVY_RUNTIME=local bash scripts/trivy-scan.sh
```

The script defaults to containers first (`docker`, then `podman`) and falls back to a local `trivy` binary only when no container engine is available. Override the image with `TRIVY_IMAGE` and the cache with `TRIVY_CACHE_DIR`.

The pinned Trivy digest was resolved from `aquasec/trivy:0.70.0` as the multi-platform manifest digest. The checkout action is also pinned by commit SHA. Update both `.github/workflows/trivy.yml` and `scripts/trivy-scan.sh` together when intentionally upgrading Trivy.
