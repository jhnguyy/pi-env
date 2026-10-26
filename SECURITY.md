# Security scanning

Treat the scanner as an untrusted program. Container isolation limits what it can read or change. Digest pinning prevents image replacement, but does not establish that the pinned image is safe.

The workflow is intentionally small:

- `.github/workflows/trivy.yml` owns the trigger, permissions, checkout bootstrap, job container, and scan command.
- `scripts/trivy-scan.sh` is the local testing entrypoint.

The durable policy is to avoid third-party scanner actions, pin executable container references by digest, and keep scanner execution outside publication permissions. Review the release identity and verify the release signature before accepting a new scanner digest. A valid signature identifies the signer, not the absence of malicious code.

The filesystem workflow scans merged commits. The [image workflow](.github/workflows/image.yml) also scans pull request candidates. Its qualification job cannot publish packages. The publisher runs on a separate runner and does not check out source or execute the candidate. It verifies the transferred archive and image identity before registry authentication.

Scanner containers retain network access for databases and checks. Read-only mounts do not prevent data exfiltration. Before disabling networking, verify that required databases and policy checks remain available without reduced scan coverage.

The policy scan blocks fixable HIGH/CRITICAL vulnerabilities and HIGH/CRITICAL secret or misconfiguration findings. The job log shows at most 50 one-line findings. The workflow does not print raw Trivy JSON reports.

Local scans require Docker or Podman. They inspect a snapshot of `HEAD`, not working-tree or staged changes. Commit changes before scanning them. The [snapshot helper](scripts/trivy-snapshot.sh) excludes untracked files, including ignored files. It preserves the committed versions of modified or deleted files. Do not commit sensitive data.

Local testing:

```bash
nub run security:trivy
# or force a specific runtime
TRIVY_RUNTIME=docker bash scripts/trivy-scan.sh
TRIVY_RUNTIME=podman bash scripts/trivy-scan.sh
```

Host execution is disabled, including the former `TRIVY_RUNTIME=local` mode. When neither container runtime is available, the scan fails instead of falling back to a host binary.

When changing scanner image, runtime flags, checkout behavior, or triggers, update all affected scan entrypoints together. Let those files remain the source of truth for exact mechanics.

## Container image boundary

The image may contain source, locked dependencies, prebuilt extension bundles, Node, Nub, Git, and OpenSSH client tooling. It must not contain private keys, GitHub tokens, SSH signing keys, pi sessions, model credentials, local notes, or mutable agent state.

Runtime identity and state must be mounted or provided externally. Image publishing is restricted to pushes on `main`. PRs scan the locally built image before publishing is possible.
