# Talos Ops — Environment & Cluster State

## Binaries

| Binary | Path | Persistent? | Version |
|---|---|---|---|
| flux | `~/.nix-profile/bin/flux` | ✅ Yes (nix profile) | v2.7.5 |
| sops | `~/.nix-profile/bin/sops` | ✅ Yes (nix profile) | v3.12.1 |
| age / age-keygen | `~/.nix-profile/bin/` | ✅ Yes (nix profile) | v1.3.1 |
| kubectl | `/tmp/kubectl` | ⚠️ Lost on LXC reboot | v1.35.3 |
| talosctl | `/tmp/talosctl` | ⚠️ Lost on LXC reboot | v1.12.6 |
| cilium CLI | `/tmp/cilium` | ⚠️ Lost on LXC reboot | v1.19.1 |

**Always set PATH before running commands:**
```bash
export PATH="$HOME/.nix-profile/bin:/tmp:$PATH"
export TALOSCONFIG=~/talos/talosconfig
export KUBECONFIG=~/talos/kubeconfig
```

**If kubectl/talosctl/cilium are missing (after LXC reboot):**
```bash
# kubectl
curl -sL "https://dl.k8s.io/release/v1.35.2/bin/linux/amd64/kubectl" -o /tmp/kubectl && chmod +x /tmp/kubectl

# talosctl
curl -sL https://github.com/siderolabs/talos/releases/download/v1.12.6/talosctl-linux-amd64 -o /tmp/talosctl && chmod +x /tmp/talosctl

# cilium CLI
curl -sL https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz | tar xz -C /tmp
```

**Open item:** Add `kubectl` and `talosctl` to LXC 302 NixOS config permanently.

---

## Credentials (all in `~/talos/`)

| File | Contents |
|---|---|
| `talosconfig` | talosctl context — endpoint + node 192.168.10.210 |
| `kubeconfig` | kubectl admin context |
| `talos-controlplane.yaml` | Applied machine config (may lag live config — use `talosctl get mc` for ground truth) |
| `flux-age-key.txt` | Flux age private key — also loaded as `sops-age` Secret in `flux-system` |

---

## talosconfig Setup

The generated `talosconfig` has empty `endpoints` and `nodes` by default. Fix once after generation:
```bash
talosctl --talosconfig ~/talos/talosconfig config endpoint 192.168.10.210
talosctl --talosconfig ~/talos/talosconfig config node 192.168.10.210
```
After this, `talosctl health` and other commands work without `--endpoints`/`--nodes` flags.

---

## Cluster Inventory

| Component | Version | Status |
|---|---|---|
| Talos Linux | v1.12.6 + iscsi-tools | VM 200, running |
| Kubernetes | v1.35.2 | Single-node control plane, Ready |
| Cilium | v1.19.1 | kube-proxy replacement, 1/1 |
| CoreDNS | bundled | 2/2 |
| Flux controllers | v2.7.5 | 4/4 in flux-system |
| registry:2 | latest | 1/1 in registry namespace |
| sops-age Secret | — | Loaded in flux-system |

**VM 200 (talos-node-0):** 8 vCPU / 12 GB RAM / 32 GB disk (tank-vms), UEFI q35, vmbr0
**LAN IP:** `192.168.10.210` (DHCP static reservation, MAC BC:24:11:A9:D0:38)
**Cluster endpoint:** `talos-node-0.jnguy.dev:6443`
**Registry endpoint:** `192.168.10.210:30500` (NodePort, HTTP, no TLS)

---

## Cert SANs

Machine config sets SANs: `talos-node-0.jnguy.dev` + `192.168.10.210`.

If IP changes during network restructure, rotate via:
```bash
# Edit certSANs in ~/talos/talos-controlplane.yaml, then:
talosctl apply-config --nodes 192.168.10.210 --file ~/talos/talos-controlplane.yaml
```

---

## NFS Exports (Cronus → talos-node-0)

```
/tank/services       talos-node-0.jnguy.dev(rw,sync,no_subtree_check,no_root_squash)
/tank/shares/photos  talos-node-0.jnguy.dev(rw,sync,no_subtree_check,no_root_squash)
```

---

## Common Commands

```bash
# Health check
talosctl health

# Node status
kubectl get nodes -o wide

# All pods
kubectl get pods -A

# Flux status (once GitOps source attached)
flux get all

# Registry test
curl -s http://192.168.10.210:30500/v2/_catalog

# Cilium status
/tmp/cilium status

# etcd members
talosctl etcd members

# Live machine config (ground truth)
talosctl get mc -n 192.168.10.210 -o yaml
```

---

## homelab-k8s Repo

Currently at `/tmp/homelab-k8s` — **lost on LXC reboot**.

Pending: run `cronus-p2-mkdirs.sh` on Cronus to create `/tank/code/homelab-k8s/`, then move the repo there.

Structure:
```
.sops.yaml              ← flux public key set, manager key TODO
apps/
  registry/             ← deployed ✅
  test/secrets.yaml     ← sops test (deployed manually for validation)
clusters/homelab/
  apps.yaml             ← Flux Kustomization (active once Forgejo wired)
```
