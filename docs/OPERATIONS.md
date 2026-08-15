# Operations runbook

## Daily commands

```bash
sudo noxctl status
sudo noxctl doctor
sudo noxctl logs web
sudo noxctl logs agent
```

`doctor` is read-only. It checks OS support, Node, permissions, systemd sandboxes, nginx, HTTPS, SQLite integrity, filesystem-index policy, loopback binding and API authorization.

## Managed security scans

ClamAV, freshclam and rkhunter are installed automatically. The default policy runs weekly through `vps-sentinel-security.timer`. Authenticated Settings can switch between weekly, daily and manual modes, start or cancel a run, and display the latest bounded report.

The scanner runs outside the web and collector services with low CPU and I/O priority, a memory cap, a six-hour timeout and control-group cancellation. Virtual filesystems and container storage are excluded. Reports are root-owned, readable only by the service group, and the latest ten are retained.

## Backup

```bash
sudo noxctl backup
sudo noxctl backup /secure/path/sentinel-backup.tar.gz
```

The archive contains a consistent SQLite snapshot, passkey/session state, root-only configuration, install metadata and nginx integration. It does not include application source or unrelated host data.

## Restore

```bash
sudo noxctl restore /secure/path/sentinel-backup.tar.gz
```

Services are stopped while state and configuration are replaced, then health-checked.

## Update

Download a release bundle and obtain its SHA-256 from `SHA256SUMS`:

```bash
sudo noxctl update ./grouvi-nox-vX.Y.Z-linux.tar.gz <sha256>
```

Update verifies the checksum and package identity, creates state and application rollback archives, stages dependencies, restarts both services and performs a health check. A failed update restores the previous application automatically.

## Passkeys

```bash
sudo noxctl enroll "Operations laptop"
sudo noxctl recovery
```

Generating recovery codes replaces the previous set.

## Uninstall

Keep state/configuration:

```bash
sudo noxctl uninstall
```

Remove everything, including state and passkeys:

```bash
sudo noxctl uninstall --purge
```

Let's Encrypt certificates are retained to avoid deleting certificates shared with another process. Remove them separately only after confirming they are unused.

## Important paths

| Purpose | Path |
|---|---|
| Application | `/opt/vps-sentinel` |
| Metrics/incidents/passkeys | `/var/lib/vps-sentinel` |
| Runtime secrets | `/etc/vps-sentinel.env` |
| Install metadata | `/etc/vps-sentinel/install.conf` |
| Lifecycle CLI | `/usr/local/sbin/noxctl` |
| nginx site | `/etc/nginx/sites-available/vps-sentinel` |
| Services | `vps-sentinel.service`, `vps-sentinel-agent.service` |

## Quality checks

Run `npm test` for unit and HTTP integration tests, `npm run test:coverage` for the enforced coverage floor, and `npm run test:visual` on a host with Playwright Chromium. CI runs all three before merge. Database changes must be added as a numbered migration in `src/db/migrations.js`.

## Settings UI

Use `/settings` for Discovery, Telegram and the optional OpenAI-compatible Nox Forge provider. Blank secret fields preserve existing configuration. Telegram test delivery happens only when the admin presses the explicit test button. CLI configuration remains available as a recovery path.
