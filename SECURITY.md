# Security scanning

## Local scans

Install Docker or Podman and commit changes before scanning them.

```bash
nub run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
```

## Container image boundary

The image may contain source, locked dependencies, prebuilt extension bundles, Node, Nub, Git, and OpenSSH client tooling. It must not contain private keys, GitHub tokens, SSH signing keys, pi sessions, model credentials, local notes, or mutable agent state.

Runtime identity and state must be mounted or provided externally.
