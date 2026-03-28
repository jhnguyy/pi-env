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
2. **Restart Unbound** (Services → Unbound DNS → Restart) — it does not pick up new static maps without a restart
3. **Verify resolution** from a node using the same DNS server:
   ```bash
   getent hosts <hostname>.jnguy.dev
   ```

**Critical:** For Talos nodes, hostname resolution must succeed *before* applying the machine config. Talos controllers use the endpoint hostname immediately after bootstrap (see [gotchas.md](gotchas.md) #3).

### NXDOMAIN Cache Gotcha

`systemd-resolved` (used by Talos and other nodes) caches NXDOMAIN responses. If a hostname was queried before the DNS entry existed, the negative cache persists even after Unbound is restarted. Wait for TTL expiry, or restart the resolver on the affected node:

```bash
# On a standard Linux host:
sudo systemctl restart systemd-resolved

# On Talos — no direct way; wait for TTL or reboot the node
```

---

## Proxmox VM Hygiene

### ISO Detachment

After successful Talos installation to disk, detach the ISO and fix the boot order. Leaving the ISO attached is low risk while the VM is running, but a hard reset could boot into maintenance mode instead of the installed OS.

**Run on Cronus:**
```bash
sudo qm set 200 --ide2 none --boot order=scsi0
```

This:
- Removes the ISO from `ide2`
- Sets boot order to `scsi0` only (the installed disk)

Verify in Proxmox config:
```
boot: order=scsi0    ← correct
# ide2 should no longer appear
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
| Display | serial0 (no VGA — Talos uses serial console) |
| Boot | order=scsi0 (after ISO detach) |

---

## Registry Mirror Configuration

The machine config has registry mirrors pre-configured for a local container registry (not yet deployed):

```yaml
registries:
  mirrors:
    192.168.10.210:5000:
      endpoints:
        - http://192.168.10.210:5000
    registry.home.jnguy.dev:5000:
      endpoints:
        - http://192.168.10.210:5000
```

This is a no-op until a registry (Harbor/Zot) is deployed at `192.168.10.210:5000`. Talos falls back to the original registry if the mirror is unreachable — existing workloads are not affected.

---

## IPC Channel (Agent ↔ Cronus)

Phase 0 established `/tank/ipc/` as the IPC channel between LXC 302 and Cronus:
- Cronus path: `/tank/ipc/`
- LXC 302 path: `/mnt/tank/ipc/` (bind mount mp4, mode 1777)

Use this for Cronus-side scripts following the standard agent-request pattern in AGENTS.md.
