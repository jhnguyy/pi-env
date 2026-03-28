# Talos Ops — Environment & Cluster State

## Binaries

Installed to `/tmp/` — **not persistent across reboots of LXC 302**. Not yet in PATH — use full paths.

| Binary | Path | Version |
|---|---|---|
| talosctl | `/tmp/talosctl` | v1.12.6 |
| kubectl | `/tmp/kubectl` | (matches k8s v1.35.2) |
| cilium CLI | `/tmp/cilium` | v1.19.1 |

**Open item:** Permanent install to `/usr/local/bin/` or `~/bin/` pending.

**If binaries are missing (e.g., after LXC reboot), re-download:**
```bash
# talosctl
curl -sL https://github.com/siderolabs/talos/releases/download/v1.12.6/talosctl-linux-amd64 \
  -o /tmp/talosctl && chmod +x /tmp/talosctl

# kubectl
curl -sL "https://dl.k8s.io/release/v1.35.2/bin/linux/amd64/kubectl" \
  -o /tmp/kubectl && chmod +x /tmp/kubectl

# cilium CLI (v1.19.1 — match helm chart version, not Cilium image version)
curl -sL https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz \
  | tar xz -C /tmp
```

---

## Credentials

All in `~/talos/` (agent home, LXC 302):

| File | Contents |
|---|---|
| `~/talos/talosconfig` | talosctl context — endpoint `192.168.10.210`, node `192.168.10.210` |
| `~/talos/kubeconfig` | kubectl context for the cluster |
| `~/talos/talos-controlplane.yaml` | Applied machine config (source of truth for node config) |

**Always set env vars before running commands:**
```bash
export TALOSCONFIG=~/talos/talosconfig
export KUBECONFIG=~/talos/kubeconfig
```

---

## talosconfig Setup

The generated `talosconfig` has empty `endpoints` and `nodes` by default. Without them, `talosctl` errors with "failed to determine endpoints". Fix once after generation:

```bash
/tmp/talosctl --talosconfig ~/talos/talosconfig config endpoint 192.168.10.210
/tmp/talosctl --talosconfig ~/talos/talosconfig config node 192.168.10.210
```

After this, `talosctl health` and other commands work without `--endpoints`/`--nodes` flags.

---

## Cluster Inventory

| Component | Version | Location |
|---|---|---|
| Talos Linux | v1.12.6 + iscsi-tools | VM 200 (talos-node-0) on Cronus |
| Kubernetes | v1.35.2 | Single-node control plane |
| Cilium | v1.19.1 | kube-proxy replacement, DaemonSet 1/1 |
| CoreDNS | (bundled) | 2/2 pods |
| etcd | (bundled) | Single member, healthy |

**VM 200 (talos-node-0):** 8 vCPU / 12 GB RAM / 32 GB disk (tank-vms), UEFI q35, vmbr0
**LAN IP:** `192.168.10.210` (DHCP static reservation, MAC BC:24:11:A9:D0:38)
**Cluster endpoint:** `talos-node-0.jnguy.dev:6443`

---

## Cert SANs

The machine config sets cert SANs for both hostname and IP:
- `talos-node-0.jnguy.dev`
- `192.168.10.210`

If the IP changes (e.g., during a network restructure), SANs must be rotated:
```bash
# Edit ~/talos/talos-controlplane.yaml to update certSANs, then:
/tmp/talosctl --talosconfig ~/talos/talosconfig apply-config \
  --nodes 192.168.10.210 \
  --file ~/talos/talos-controlplane.yaml
```

---

## NFS Exports (Cronus → talos-node-0)

Configured on Cronus `/etc/exports`:
```
/tank/services       talos-node-0.jnguy.dev(rw,sync,no_subtree_check,no_root_squash)
/tank/shares/photos  talos-node-0.jnguy.dev(rw,sync,no_subtree_check,no_root_squash)
```

Uses hostname-based client spec (not IP) — consistent with DHCP-as-source-of-truth principle.

---

## Common Commands

```bash
# Health check
/tmp/talosctl health

# Node status
/tmp/kubectl get nodes -o wide

# All pods
/tmp/kubectl get pods -A

# Cilium status
/tmp/cilium status

# etcd members
/tmp/talosctl etcd members

# Node diagnostics (should be empty)
/tmp/talosctl get diagnostics

# Talos/k8s versions
/tmp/talosctl version
```
