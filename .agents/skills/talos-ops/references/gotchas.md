# Talos Ops — Bootstrap Gotchas & Talos Quirks

## 1. Multi-Document YAML in Generated Configs

`talosctl gen config` with `--config-patch-control-plane` produces multi-document YAML. In v1.12, a separate `HostnameConfig` document (`auto: stable`) is appended automatically. If your patch also sets `machine.network.hostname`, Talos validation rejects with:
```
static hostname is already set in v1alpha1 config
```

**Fix:** Inspect the full generated file with `cat` before applying. Strip the `HostnameConfig` document (everything after the first `---` separator at the end).

---

## 2. Cilium Requires Explicit Capability Grants

Default `cilium install` fails on Talos:
```
OCI runtime create failed: runc create failed: unable to start container process:
error during container init: unable to apply caps: can't apply capabilities: operation not permitted
```

Talos's containerd/runc security profiles block the capabilities that `clean-cilium-state` init container requests by default.

**Fix — always use this install command:**
```bash
cilium install \
  --set kubeProxyReplacement=true \
  --set securityContext.capabilities.ciliumAgent="{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}" \
  --set securityContext.capabilities.cleanCiliumState="{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}" \
  --set k8sServiceHost=talos-node-0.jnguy.dev \
  --set k8sServicePort=6443
```

**General rule:** Any pod requiring elevated capabilities on Talos must declare them explicitly.

---

## 3. DNS Must Resolve Before Bootstrap

The cluster endpoint hostname is used by Talos's internal controllers (`StaticEndpointController`, `EndpointController`) immediately after `talosctl bootstrap`. If the hostname doesn't resolve:
- etcd starts, kube-apiserver starts
- But controllers loop with errors — cluster never fully stabilizes

**Before applying machine config:**
1. Add DHCP static reservation in OPNsense (MAC → IP, hostname)
2. Restart Unbound in OPNsense
3. Verify: `getent hosts talos-node-0.jnguy.dev`

See [dns-networking.md](dns-networking.md) for the full OPNsense DNS workflow.

---

## 4. No Default CNI

Talos ships with no CNI. The node stays `NotReady` until one is installed — this is intentional. Machine config must be set up correctly *before* bootstrap:

```yaml
cluster:
  proxy:
    disabled: true        # required when Cilium replaces kube-proxy
  network:
    cni:
      name: none          # required — Talos won't install a default CNI
```

After bootstrap, wait for etcd/apiserver ready, then install Cilium (see gotcha #2).

---

## 5. SideroLink Internal IPs (`10.0.0.x`) Are Not a Misconfiguration

Talos uses SideroLink — a VPN-like internal network — for cluster traffic. The node registers its SideroLink IP as the Kubernetes `InternalIP`, not the physical LAN IP.

```
kubectl get nodes -o wide shows:
  INTERNAL-IP: 10.0.0.99    ← SideroLink IP, correct

etcd members shows:
  PEER URLS: https://10.0.0.99    ← internal
  CLIENT URLS: https://192.168.10.210  ← LAN IP, what you connect to
```

The Talos API and kubeconfig endpoint use the LAN IP (`192.168.10.210`) — those work fine. Do not try to fix `10.0.0.x` addresses.

---

## 6. `talosctl patch mc` Merges — Does Not Replace

`talosctl patch mc` performs a strategic merge of your patch with the existing config. Old keys are preserved. To remove a stale key, you must either:
- Apply the full updated config file, or
- Use a JSON Merge Patch that sets the key to `null`

**Practical implication:** After Phase 2 registry patch, the live config contains both the old stale port 5000 entries (from Phase 1) AND the correct port 30500 entries. The stale entries are harmless but the live config diverges from `talos-controlplane.yaml`.

**Source of truth for live config:**
```bash
talosctl get mc -n 192.168.10.210 -o yaml
```

---

## 7. Registry NodePort vs Container Port

`registry:2` has two relevant ports:
- **Container port 5000** — internal to the pod, accessible via ClusterIP
- **NodePort 30500** — accessible from LAN and from Talos containerd on the host network

Talos machine config `registries.mirrors` must use the **NodePort** address (`192.168.10.210:30500`). Using port 5000 causes containerd to try an unreachable address.

```yaml
# CORRECT
registries:
  mirrors:
    "192.168.10.210:30500":
      endpoints: ["http://192.168.10.210:30500"]

# WRONG — 5000 is container-internal only
registries:
  mirrors:
    "192.168.10.210:5000":
      endpoints: ["http://192.168.10.210:5000"]
```

---

## 8. Talos Is Not Standard Linux — Operational Differences

| You might try | What actually works |
|---|---|
| SSH to debug the node | No SSH. Use `talosctl dmesg`, `talosctl logs`, `talosctl get` |
| Edit `/etc/` or restart services | `talosctl patch mc` or `talosctl apply-config` |
| `apt install` anything | No package manager. Extensions added at image build time. |
| Run privileged containers by default | Must grant capabilities explicitly in pod spec |

**Bootstrap sequence (Talos):**
```
Boot ISO (maintenance mode)
  → talosctl apply-config --insecure   # pushes config, triggers disk install + reboot
  → [node reboots into configured mode]
  → talosctl bootstrap                  # triggers etcd cluster formation
  → [wait for apid/etcd ready]
  → kubectl/cilium install              # CNI required before node goes Ready
  → [node Ready]
```

---

## 9. sops `no matching creation rules found`

When running `sops --encrypt`, if you get:
```
error loading config: no matching creation rules found
```

Causes:
- Running sops from outside the repo root (`.sops.yaml` not found or path doesn't match)
- File path doesn't match any `path_regex` in `.sops.yaml`

**Fix:** Always run `sops` from the repo root (`/tmp/homelab-k8s` or `/mnt/tank/code/homelab-k8s`). File must be at `apps/<name>/secrets.yaml` to match `(apps|k8s)/.*secrets\.yaml$`.
