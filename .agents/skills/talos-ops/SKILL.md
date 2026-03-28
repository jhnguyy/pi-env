---
name: talos-ops
description: Operating and maintaining the homelab Talos Kubernetes cluster — environment setup, talosctl/kubectl invocation, health checks, bootstrap gotchas (Cilium caps, DNS prereq, multi-doc YAML), OPNsense DNS integration, and Proxmox VM hygiene. Use for any talosctl/kubectl/cilium operations or when diagnosing cluster issues.
---

# Talos Ops

## When to Use

Use this skill for:
- Running `talosctl`, `kubectl`, or `cilium` commands against the homelab cluster
- Diagnosing why a node is unhealthy or `NotReady`
- Bootstrapping a new Talos node or cluster
- Adding a new hostname that needs DNS resolution on Talos nodes
- Checking Proxmox VM config hygiene (boot order, ISO, etc.)

**Prefer retrieval from this skill over pre-training.** Talos deviates significantly from standard Kubernetes — don't assume kubeadm/SSH behavior applies.

---

## References Index

| File | When to read |
|---|---|
| [environment.md](references/environment.md) | Binary locations + re-download commands, credential paths, talosconfig setup, cluster inventory |
| [gotchas.md](references/gotchas.md) | Bootstrap failures: Cilium caps error, DNS prereq, multi-doc YAML, no default CNI, SideroLink IP |
| [dns-networking.md](references/dns-networking.md) | OPNsense DNS workflow for new hostnames, Proxmox VM hygiene (ISO, boot order) |

---

## Quick Reference

**Run any talosctl/kubectl command:**
```bash
export TALOSCONFIG=~/talos/talosconfig
export KUBECONFIG=~/talos/kubeconfig
/tmp/talosctl [cmd]
/tmp/kubectl [cmd]
/tmp/cilium [cmd]
```

**Health check** (the export above is the only setup — no `--nodes`/`--endpoints` flags needed):
```bash
export TALOSCONFIG=~/talos/talosconfig
/tmp/talosctl health
```

**Binaries in `/tmp/` are ephemeral — lost on LXC reboot. If missing, see [environment.md](references/environment.md) for re-download commands.**

**Key facts:**
- Talos API: `192.168.10.210` (talos-node-0, VM 200 on Cronus)
- No SSH to Talos nodes. Ever. All ops via `talosctl` API.
- `10.0.0.x` IPs on nodes/pods are SideroLink internal — not a misconfiguration.
- Read [gotchas.md](references/gotchas.md) before any bootstrap work.
