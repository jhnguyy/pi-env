# Security scanning

This repository has a manual Trivy entrypoint but no automatic scan workflow yet.

```bash
bun run security:trivy
# or
bash scripts/trivy-scan.sh
```

The script prefers a local `trivy` binary and falls back to `docker run aquasec/trivy:latest` or `podman run aquasec/trivy:latest`.

GitHub Actions is intentionally not enabled in this change. A future workflow can call the same script after deciding on the desired trigger and reporting policy.
