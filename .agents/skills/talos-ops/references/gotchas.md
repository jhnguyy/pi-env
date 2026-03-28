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
/tmp/cilium install \
  --set kubeProxyReplacement=true \
  --set securityContext.capabilities.ciliumAgent="{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}" \
  --set securityContext.capabilities.cleanCiliumState="{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}" \
  --set k8sServiceHost=talos-node-0.jnguy.dev \
  --set k8sServicePort=6443
```

**General rule:** Any pod requiring elevated capabilities on Talos must declare them explicitly. This is not a Cilium-specific issue — it applies to anything that needs `SYS_ADMIN`, `NET_ADMIN`, etc.

---

## 3. DNS Must Resolve Before Bootstrap

The cluster endpoint hostname is used by Talos's internal controllers (`StaticEndpointController`, `EndpointController`) immediately after `talosctl bootstrap`. If the hostname doesn't resolve:
- etcd starts
- kube-apiserver starts
- But controllers loop with errors — cluster never fully stabilizes

Talos uses `systemd-resolved` (`127.0.0.53`) which forwards to DHCP-provided nameservers. **Before applying machine config:**
1. Add DHCP static reservation in OPNsense (MAC → IP, hostname)
2. Restart Unbound in OPNsense
3. Verify resolution: `getent hosts talos-node-0.jnguy.dev` from a node that uses the same DNS server

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

After bootstrapping and waiting for etcd/apiserver to be ready, install Cilium (see gotcha #2).

---

## 5. SideroLink Internal IPs (`10.0.0.x`) Are Not a Misconfiguration

Talos uses SideroLink — a VPN-like internal network — for cluster traffic. The node registers its SideroLink IP as the Kubernetes `InternalIP`, not the physical LAN IP.

```
# kubectl get nodes -o wide shows:
NAME           STATUS   ROLES           INTERNAL-IP   
talos-node-0   Ready    control-plane   10.0.0.99     ← SideroLink IP, correct

# etcd members shows:
PEER URLS           CLIENT URLS
https://10.0.0.99   https://192.168.10.210  ← peers via SideroLink, client via LAN IP
```

The Talos API and kubeconfig endpoint use the LAN IP (`192.168.10.210`) — those work fine. `10.0.0.x` addresses for pods/nodes are expected. Do not try to fix this.

---

## 6. Talos Is Not Standard Linux — Operational Differences

| You might try | What actually works |
|---|---|
| SSH to debug the node | No SSH. Use `talosctl dmesg`, `talosctl logs`, `talosctl get` |
| Edit `/etc/` or restart services | Apply updated `controlplane.yaml` via `talosctl apply-config` |
| `apt install` anything | No package manager. Extensions added at image build time. |
| Run privileged containers by default | Must grant capabilities explicitly in pod spec |
| Expect kubeadm behavior | Talos bootstrap sequence is entirely different — see below |

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
