# Security scanning

This repository runs Trivy only after changes land on `main`.

The workflow is intentionally small:

- `.github/workflows/trivy.yml` owns the trigger, permissions, checkout bootstrap, job container, and scan command.
- `scripts/trivy-scan.sh` is the local testing entrypoint.

The durable policy is to avoid running Trivy on pull request branches, avoid third-party scanner actions, pin executable container references by digest, and keep checkout separate from scanner action lifecycle hooks. The workflow checks out into a writable temp path inside the job container instead of relying on the default GitHub workspace path.

Local testing:

```bash
nub run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
TRIVY_RUNTIME=local bash scripts/trivy-scan.sh
```

When changing scanner image, runtime flags, checkout behavior, or triggers, update the workflow and script together and let those files remain the source of truth for exact mechanics.

## Container image boundary

The image may contain source, locked dependencies, prebuilt extension bundles, Node, Nub, Git, and OpenSSH client tooling. It must not contain private keys, GitHub tokens, SSH signing keys, pi sessions, model credentials, local notes, or mutable agent state.

Runtime identity and state must be mounted or provided externally. Image publishing is restricted to pushes on `main`.
