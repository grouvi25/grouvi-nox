# Production installation

## Support matrix

- Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12
- x86_64 and aarch64
- systemd, nginx and a real DNS hostname
- Root access for installation

The dashboard requires HTTPS because passkeys use WebAuthn. Installation by raw IP is intentionally unsupported.

## 1. Download and verify

Download these two files from the same GitHub Release:

- `vps-sentinel-vX.Y.Z-linux.tar.gz`
- `SHA256SUMS`

```bash
sha256sum -c SHA256SUMS
tar -xzf vps-sentinel-vX.Y.Z-linux.tar.gz
cd vps-sentinel-vX.Y.Z
```

Never use `curl | sh`. The installer is a local file and can be reviewed before execution.

## 2. DNS

Create an A/AAAA record for the intended hostname. Examples:

- Public origin: `monitor.example.com` points directly to the VPS.
- Cloudflare origin: enable the orange proxy and use `--proxy cloudflare`; Sentinel then rejects direct traffic from non-Cloudflare peers.

## 3. Dry-run

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy public \
  --dry-run --non-interactive -y
```

Dry-run validates OS, architecture, domain, port, package identity and the installation plan without changing the host.

## 4. Install

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy public
```

Cloudflare origin lock:

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy cloudflare
```

Optional Telegram and monitored folders:

```bash
sudo ./deploy/install.sh \
  --domain monitor.example.com \
  --email ops@example.com \
  --proxy cloudflare \
  --telegram-token "$BOT_TOKEN" \
  --telegram-chat-id "$CHAT_ID" \
  --backup-dirs /srv/backups,/opt/app/backups \
  --deploy-dirs /opt/app,/opt/worker
```

Secrets are written to `/etc/vps-sentinel.env` with mode `0600` and are not printed.

## 5. First access

The installer prints a one-time enrollment URL and ten recovery codes. Open the URL on the device that will hold the passkey. Store recovery codes offline.

```bash
sudo sentinelctl status
sudo sentinelctl doctor
```

## What the installer changes

- Creates the `vpssentinel` system user.
- Installs runtime packages and Node.js 20 from a signed apt repository if required.
- Copies the verified release to `/opt/vps-sentinel`.
- Creates root-only configuration and a mode-0700 state directory.
- Configures nginx, Let's Encrypt, systemd and optional UFW.
- Starts a sandboxed unprivileged web service and a narrow read-only host collector.
- Does not alter SSH authentication, application containers or unrelated virtual hosts.

A timestamped pre-install backup is created under `/root` before existing integration files are changed.

## First-login setup wizard

After enrolling the first passkey, the dashboard redirects to `/setup`. Discovery Engine scans standard Linux application roots, Docker, PM2, systemd and nginx, then proposes monitoring targets with confidence scores. Admins can change scan roots and disable any target. Empty `--backup-dirs` and `--deploy-dirs` values mean discovery-managed; explicit values remain pinned overrides.

Secrets are deliberately outside the browser settings store:

```bash
sudo sentinelctl configure telegram
sudo sentinelctl configure ai
```
