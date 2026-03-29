# Talos Ops — DNS, Networking & Proxmox Hygiene

## OPNsense DNS Integration

OPNsense Unbound is configured with split DHCP registration:

| Setting | Value | Meaning |
|---|---|---|
| `regdhcp` | `0` | Dynamic leases NOT registered — prevents pollution from phones/IoT |
| `regdhcpstatic` | `1` | Static reservations ARE registered — infrastructure hostnames resolve |
| `regdhcpdomain` | `jnguy.dev` | Domain suffix — hostnames registered as `<name>.jnguy.dev` |

### Workflow: Adding a New Infrastructure Hostname

1. **Add DHCP static reservation** in OPNsense: MAC → IP + hostname
2. **Restart Unbound** (Services → Unbound DNS → Restart) — does not pick up new static maps without restart
3. **Verify resolution:**
   ```bash
   getent hosts <hostname>.jnguy.dev
   ```

**Critical:** For Talos nodes, hostname resolution must succeed *before* applying the machine config. Talos controllers use the endpoint hostname immediately after bootstrap.

### NXDOMAIN Cache Gotcha

`systemd-resolved` caches NXDOMAIN responses. If a hostname was queried before the DNS entry existed, the negative cache persists after Unbound is restarted. Wait for TTL expiry or restart the resolver on the affected host.

---

## Proxmox VM Hygiene

### ISO Detachment (pending for VM 200)

After Talos installation to disk, detach the ISO. Leaving it attached is low risk while running, but a hard reset could boot into maintenance mode.

**Run on Cronus:**
```bash
sudo qm set 200 --ide2 none --boot order=scsi0
```

### VM 200 Expected Config

| Field | Value |
|---|---|
| Name | talos-node-0 |
| CPU | 8 cores (host type) |
| RAM | 12 GB |
| Disk | 32 GB scsi0 on tank-vms, discard+iothread |
| Network | virtio on vmbr0, MAC BC:24:11:A9:D0:38 |
| BIOS | OVMF (UEFI) |
| Machine | q35 |
| Boot | order=scsi0 (after ISO detach) |

---

## Registry Mirror Configuration

Talos machine config has mirrors for the local registry on NodePort **30500** (not 5000 — that is the container-internal port).

```yaml
machine:
  registries:
    mirrors:
      "192.168.10.210:30500":
        endpoints:
          - "http://192.168.10.210:30500"
      "talos-node-0.jnguy.dev:30500":
        endpoints:
          - "http://192.168.10.210:30500"
    config:
      "192.168.10.210:30500":
        tls:
          insecureSkipVerify: true
```

**Important:** Stale entries for port 5000 may remain in the live config from Phase 1. They are harmless (nothing uses them) but the live config diverges from `talos-controlplane.yaml`. Use `talosctl get mc -n 192.168.10.210 -o yaml` for the authoritative config.

When pulling an image referenced as `192.168.10.210:30500/myimage:tag`, containerd looks up `192.168.10.210:30500` in the mirrors list and uses the configured endpoint with `insecureSkipVerify: true`. The mirror key **must match the registry hostname:port in the image reference exactly**.

---

## IPC Channel (Agent ↔ Cronus)

`/tank/ipc/` on Cronus = `/mnt/tank/ipc/` on LXC 302 (bind mount mp4, mode 1777).

Scripts written by agent → run by user on Cronus → result file written back → agent reads result.

See AGENTS.md Cronus Communication section for full protocol.
