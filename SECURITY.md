# Security scanning

Treat the scanner as an untrusted program. Container isolation limits what it can read or change. Digest pinning prevents image replacement, but does not establish that the pinned image is safe.

The durable policy is to avoid third-party scanner actions, pin executable container references by digest, and keep scanner execution outside publication permissions. Review the release identity and verify the release signature before accepting a new scanner digest. A valid signature identifies the signer, not the absence of malicious code.

Scanner containers retain network access for databases and checks. Read-only mounts do not prevent data exfiltration. Before disabling networking, verify that required databases and policy checks remain available without reduced scan coverage.

## Local scans

Install Docker or Podman and commit changes before scanning them. The scan uses `HEAD`, not working-tree or staged changes. Do not commit sensitive data.

```bash
nub run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
```

## Container image boundary

The image may contain source, locked dependencies, prebuilt extension bundles, Node, Nub, Git, and OpenSSH client tooling. It must not contain private keys, GitHub tokens, SSH signing keys, pi sessions, model credentials, local notes, or mutable agent state.

Runtime identity and state must be mounted or provided externally.
