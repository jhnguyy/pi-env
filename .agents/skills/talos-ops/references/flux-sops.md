# Talos Ops — Flux + sops + age

## Cluster State

Flux v2.7.5 controllers are installed via `flux install` (no GitRepository source yet).
GitOps loop activates in Phase 2.5 when Forgejo is deployed and `flux bootstrap git` is run.

| Controller | Namespace | Status |
|---|---|---|
| source-controller | flux-system | Running |
| kustomize-controller | flux-system | Running |
| helm-controller | flux-system | Running |
| notification-controller | flux-system | Running |
| sops-age Secret | flux-system | Loaded |

**Flux age public key:** `age1e7tkr8ln7prgfglc9ny6axc4yqpj5ax7es9znjsnp2g85hchq55qdqhpem`

---

## `flux install` vs `flux bootstrap git`

- **`flux install`** — deploys controllers only. No GitRepository, no reconciliation loop. Use temporarily until a git server exists.
- **`flux bootstrap git`** — full GitOps. Creates GitRepository + root Kustomization, Flux reconciles continuously.

**When Forgejo is ready (Phase 2.5):**
```bash
flux bootstrap git \
  --url=http://forgejo.home.jnguy.dev/jhnguyy/homelab-k8s \
  --path=clusters/homelab \
  --branch=main
```

---

## homelab-k8s Repo Structure

```
.sops.yaml
.gitignore               ← excludes *.agekey, flux-age-key.txt, *-plaintext.yaml
apps/
  kustomization.yaml     ← includes all app dirs
  registry/              ← deployed ✅
    namespace.yaml, pv.yaml, pvc.yaml, deployment.yaml, service.yaml
  test/
    secrets.yaml         ← sops-encrypted test Secret (validated)
  <service>/             ← added per Phase 3 service migration
    secrets.yaml         ← sops-encrypted
clusters/homelab/
  apps.yaml              ← Flux Kustomization with decryption block
```

**Apply manually (until Forgejo wired):**
```bash
export KUBECONFIG=~/talos/kubeconfig
kubectl apply -k /mnt/tank/code/homelab-k8s/apps/<service>/
```

---

## sops Encryption

### Path convention
Encrypted files must be named `secrets.yaml` under `apps/` or `k8s/` to match `.sops.yaml` creation_rules:
```
(apps|k8s)/.*secrets\.yaml$
```

### Encrypt a new secret
```bash
cd /mnt/tank/code/homelab-k8s

# Write plaintext (DO NOT COMMIT — will be replaced):
cat > apps/<service>/secrets.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: <service>-secrets
  namespace: <service>
stringData:
  MY_KEY: "my-value"
EOF

# Encrypt in-place:
sops --encrypt apps/<service>/secrets.yaml > /tmp/enc.yaml \
  && mv /tmp/enc.yaml apps/<service>/secrets.yaml

# Verify decrypt works:
SOPS_AGE_KEY_FILE=~/talos/flux-age-key.txt sops --decrypt apps/<service>/secrets.yaml
```

### Common error: no matching creation rules
```
error loading config: no matching creation rules found
```
Means the file path doesn't match any `path_regex` in `.sops.yaml`. Run sops from the repo root. File must be named `secrets.yaml` and placed at `apps/<name>/secrets.yaml` or `k8s/<name>/secrets.yaml`.

---

## Kustomization Decryption Block

Every Flux `Kustomization` that applies encrypted files needs this in its spec:
```yaml
spec:
  decryption:
    provider: sops
    secretRef:
      name: sops-age
```

The `sops-age` Secret in `flux-system` contains the age private key at key `age.agekey`.

---

## Age Key Management

| Key | Location | Purpose |
|---|---|---|
| Flux private key | `~/talos/flux-age-key.txt` AND `sops-age` k8s Secret | In-cluster decryption by Flux |
| Manager private key | nix-manager (TODO: generate) | Re-encryption by human operator |

**Generate manager key on nix-manager:**
```bash
age-keygen -o manager-age-key.txt
# Add public key to .sops.yaml under keys:
# Re-key existing files: sops updatekeys apps/<service>/secrets.yaml
```

Until manager key is added, only the Flux key can decrypt. The homelab-agent can decrypt locally using `~/talos/flux-age-key.txt` (acceptable — same security boundary as kubeconfig).

---

## Flux Commands

```bash
export PATH="$HOME/.nix-profile/bin:$PATH"
export KUBECONFIG=~/talos/kubeconfig

# Check controller status
flux check

# List all Flux resources
flux get all

# Force reconciliation
flux reconcile kustomization apps --with-source

# View Flux events
flux events

# Uninstall (rollback)
flux uninstall
```
