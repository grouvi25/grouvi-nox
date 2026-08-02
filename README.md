# VPS Sentinel

A production-grade, passkey-only monitoring dashboard for Linux VPS hosts. It combines realtime metrics, persistent history, incidents, Telegram alerts, Docker/PM2 drill-down, deployment history and a metadata-only filesystem explorer.

## Install on a clean VPS

Supported: Ubuntu 22.04/24.04 and Debian 12 on x86_64 or aarch64.

1. Download the release archive and `SHA256SUMS` from GitHub Releases.
2. Verify before extraction:

```bash
sha256sum -c SHA256SUMS
tar -xzf vps-sentinel-vX.Y.Z-linux.tar.gz
cd vps-sentinel-vX.Y.Z
```

3. Validate without changing the host:

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy public \
  --dry-run --non-interactive -y
```

4. Install:

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy public
```

For an orange-cloud Cloudflare record, use `--proxy cloudflare`; the origin then rejects direct non-Cloudflare traffic.

**Do not install with `curl | sh`.** Every release publishes a SHA-256 manifest; public repositories additionally publish GitHub build-provenance attestations. Private repositories do not support GitHub attestations, so verify the checksum from the authenticated release page.

Full guide: [docs/INSTALL.md](docs/INSTALL.md)

## What it monitors

- CPU per core, memory, swap, load, disk I/O, filesystems and network throughput
- Docker containers, health, resource usage and redacted log tails
- PM2 status, restarts, runtime usage and redacted log tails
- systemd failures, nginx, Docker, SSH and fail2ban
- TLS expiry for nginx hostnames
- Backup freshness and Git deployment timeline
- SSH brute-force activity and recent logins
- Metadata-only filesystem tree, large files and permission risks
- SQLite history for 1 hour, 24 hours, 7 days and 30 days
- Incident lifecycle with acknowledgement, resolution and Telegram deduplication

## Security model

- Passkey-only authentication with required user verification
- Enrollment closed by default; one-time links plus scrypt-hashed recovery codes
- Unprivileged loopback-only web process inside a systemd sandbox
- Separate read-only host collector with no network listener
- No shell, file-content endpoint, restart action or arbitrary command execution
- Strict CSP, HSTS, same-origin enforcement, signed cookies and rate limits
- Root-only runtime configuration; secrets never enter releases or browser payloads
- Cloudflare mode fails closed if its edge IP ranges cannot be verified

See [docs/SECURITY.md](docs/SECURITY.md).

## Operations

```bash
sudo sentinelctl status
sudo sentinelctl doctor
sudo sentinelctl enroll "New laptop"
sudo sentinelctl backup
sudo sentinelctl logs web
```

Verified updates require a local release bundle and its expected SHA-256:

```bash
sudo sentinelctl update ./vps-sentinel-vX.Y.Z-linux.tar.gz <sha256>
```

Update creates application and state rollback archives, then automatically restores the previous app if staging or health checks fail.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Architecture

```text
Browser (passkey)
       │ HTTPS
       ▼
nginx / Cloudflare origin lock
       │ loopback
       ▼
vps-sentinel (unprivileged, read-only API)
       │ reads bounded snapshots
       ├──────── SQLite history + incidents
       ▼
vps-sentinel-agent (root, no listener, metadata only)
```

## License

Apache-2.0
