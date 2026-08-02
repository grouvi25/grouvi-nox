# Operations runbook

## Daily commands

```bash
sudo sentinelctl status
sudo sentinelctl doctor
sudo sentinelctl logs web
sudo sentinelctl logs agent
```

`doctor` is read-only. It checks OS support, Node, permissions, systemd sandboxes, nginx, HTTPS, SQLite integrity, filesystem-index policy, loopback binding and API authorization.

## Backup

```bash
sudo sentinelctl backup
sudo sentinelctl backup /secure/path/sentinel-backup.tar.gz
```

The archive contains a consistent SQLite snapshot, passkey/session state, root-only configuration, install metadata and nginx integration. It does not include application source or unrelated host data.

## Restore

```bash
sudo sentinelctl restore /secure/path/sentinel-backup.tar.gz
```

Services are stopped while state and configuration are replaced, then health-checked.

## Update

Download a release bundle and obtain its SHA-256 from `SHA256SUMS`:

```bash
sudo sentinelctl update ./vps-sentinel-vX.Y.Z-linux.tar.gz <sha256>
```

Update verifies the checksum and package identity, creates state and application rollback archives, stages dependencies, restarts both services and performs a health check. A failed update restores the previous application automatically.

## Passkeys

```bash
sudo sentinelctl enroll "Operations laptop"
sudo sentinelctl recovery
```

Generating recovery codes replaces the previous set.

## Uninstall

Keep state/configuration:

```bash
sudo sentinelctl uninstall
```

Remove everything, including state and passkeys:

```bash
sudo sentinelctl uninstall --purge
```

Let's Encrypt certificates are retained to avoid deleting certificates shared with another process. Remove them separately only after confirming they are unused.

## Important paths

| Purpose | Path |
|---|---|
| Application | `/opt/vps-sentinel` |
| Metrics/incidents/passkeys | `/var/lib/vps-sentinel` |
| Runtime secrets | `/etc/vps-sentinel.env` |
| Install metadata | `/etc/vps-sentinel/install.conf` |
| Lifecycle CLI | `/usr/local/sbin/sentinelctl` |
| nginx site | `/etc/nginx/sites-available/vps-sentinel` |
| Services | `vps-sentinel.service`, `vps-sentinel-agent.service` |
