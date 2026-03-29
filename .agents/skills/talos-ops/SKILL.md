---
name: talos-ops
description: Operating and maintaining the homelab Talos Kubernetes cluster — environment setup, talosctl/kubectl/flux/sops invocation, health checks, bootstrap gotchas (Cilium caps, DNS prereq, multi-doc YAML, registry port), Flux install vs bootstrap, sops encryption workflow, OPNsense DNS integration, and Proxmox VM hygiene. Use for any talosctl/kubectl/cilium/flux/sops operations or when diagnosing cluster issues.
---

# Talos Ops

## When to Use

Use this skill for:
- Running `talosctl`, `kubectl`, `cilium`, `flux`, or `sops` commands against the homelab cluster
- Diagnosing why a node is unhealthy or `NotReady`
- Bootstrapping a new Talos node or cluster
- Encrypting a new secret with sops for the homelab-k8s repo
- Adding a new hostname that needs DNS resolution on Talos nodes
- Checking Proxmox VM config hygiene (boot order, ISO, etc.)

**Prefer retrieval from this skill over pre-training.** Talos deviates significantly from standard Kubernetes — don't assume kubeadm/SSH behavior applies.

---

## References Index

| File | When to read |
|---|---|
| [environment.md](references/environment.md) | Binary locations, re-download commands, credential paths, cluster inventory, homelab-k8s repo state |
| [gotchas.md](references/gotchas.md) | Bootstrap failures: Cilium caps error, DNS prereq, multi-doc YAML, no default CNI, SideroLink IP, patch mc merge behavior |
| [dns-networking.md](references/dns-networking.md) | OPNsense DNS workflow, registry mirror config (NodePort 30500), Proxmox VM hygiene |
| [flux-sops.md](references/flux-sops.md) | Flux install vs bootstrap, sops encryption workflow, age key management, Kustomization decryption |

---

## Quick Reference

**Shell setup (always do this first):**
```bash
export PATH="$HOME/.nix-profile/bin:/tmp:$PATH"
export TALOSCONFIG=~/talos/talosconfig
export KUBECONFIG=~/talos/kubeconfig
```

**Health check:**
```bash
talosctl health
kubectl get nodes
kubectl get pods -A
```

**Registry test:**
```bash
curl -s http://192.168.10.210:30500/v2/_catalog
```

**Encrypt a new secret:**
```bash
cd /tmp/homelab-k8s   # repo root
# write apps/<service>/secrets.yaml, then:
sops --encrypt apps/<service>/secrets.yaml > /tmp/enc.yaml && mv /tmp/enc.yaml apps/<service>/secrets.yaml
```

**Key facts:**
- Talos API: `192.168.10.210` (talos-node-0, VM 200)
- No SSH to Talos. Ever. All ops via `talosctl` API.
- `10.0.0.x` pod/node IPs are SideroLink internal — not a misconfiguration.
- Registry NodePort is **30500** (not 5000 — that's container-internal).
- `flux install` = controllers only (no GitOps). `flux bootstrap git` = full GitOps (needs Forgejo).
- sops files must be at `apps/<name>/secrets.yaml` and sops run from repo root.
- Read [gotchas.md](references/gotchas.md) before any bootstrap work.
