# Production installation

## Support matrix

- Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12
- x86_64 and aarch64
- systemd, nginx and a real DNS hostname
- Root access for installation

The dashboard requires HTTPS because passkeys use WebAuthn. Installation by raw IP is intentionally unsupported.

## 1. Download and verify

Download these two files from the same GitHub Release:

- `grouvi-nox-vX.Y.Z-linux.tar.gz`
- `SHA256SUMS`

```bash
sha256sum -c SHA256SUMS
tar -xzf grouvi-nox-vX.Y.Z-linux.tar.gz
cd grouvi-nox-vX.Y.Z
```

Never use `curl | sh`. The installer is a local file and can be reviewed before execution.

## 2. DNS

Create an A/AAAA record for the intended hostname. Examples:

- Public origin: `monitor.example.com` points directly to the VPS.
- Cloudflare origin: enable the orange proxy and use `--proxy cloudflare`; Grouvi Nox then rejects direct traffic from non-Cloudflare peers.

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

Nox Forge and its pinned Hermes runtime are installed by default. The AI key may be supplied during installation or entered later in the authenticated Settings page.

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
  --deploy-dirs /opt/app,/opt/worker \
  --ai-base-url https://api.example.com/v1 \
  --ai-model Qwen3.6-35B-A3B \
  --ai-fallback-model DeepSeek-V4-Pro \
  --ai-key "$AI_API_KEY"
```

Secrets are written to `/etc/vps-sentinel.env` with mode `0600` and are not printed.

## 5. First access

The installer prints a one-time enrollment URL and ten recovery codes. Open the URL on the device that will hold the passkey. Store recovery codes offline.

```bash
sudo noxctl status
sudo noxctl doctor
```

## What the installer changes

- Creates the `vpssentinel` system user.
- Installs runtime packages and Node.js 20 from a signed apt repository if required.
- Copies the verified release to `/opt/vps-sentinel`.
- Creates root-only configuration and a mode-0700 state directory.
- Configures nginx, Let's Encrypt, systemd and optional UFW.
- Starts a sandboxed unprivileged web service and a narrow read-only host collector.
- Installs a commit-pinned Hermes runtime, isolated `sentinel-ai` user, sanitized context timer and local-only Nox Forge bridge.
- Automatically creates editable Forge workspace copies for enabled discovered Git projects. Production repositories remain read-only.
- Does not alter SSH authentication, application containers or unrelated virtual hosts.

A timestamped pre-install backup is created under `/root` before existing integration files are changed.

## First-login setup wizard

After enrolling the first passkey, the dashboard redirects to `/setup`. Discovery Engine scans standard Linux application roots, Docker, PM2, systemd and nginx, then proposes monitoring targets with confidence scores. Admins can change scan roots and disable any target. Empty `--backup-dirs` and `--deploy-dirs` values mean discovery-managed; explicit values remain pinned overrides.

Forge is usable immediately when `--ai-key` is supplied. Without a key, all Forge components still install and the provider is completed in `/settings`; no reinstall is needed. Use `--without-forge` only when AI is deliberately unwanted. DNS ownership, provider credentials and creating the first passkey cannot be invented safely, so they remain explicit operator inputs. Everything after those inputs is automated.

Secrets are deliberately outside the browser settings store:

```bash
sudo noxctl configure telegram
sudo noxctl configure ai
```
