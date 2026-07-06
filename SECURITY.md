# Security scanning

This repository runs Trivy only after changes land on `main`.

The workflow is intentionally small:

- `.github/workflows/trivy.yml` owns the trigger, permissions, checkout bootstrap, job container, and scan command.
- `scripts/trivy-scan.sh` is the local testing entrypoint.

The durable policy is to avoid running Trivy on pull request branches, avoid third-party scanner actions, pin executable container references by digest, and keep checkout separate from scanner action lifecycle hooks.

Local testing:

```bash
nub run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
TRIVY_RUNTIME=local bash scripts/trivy-scan.sh
```

When changing scanner image, runtime flags, checkout behavior, or triggers, update the workflow and script together and let those files remain the source of truth for exact mechanics.
