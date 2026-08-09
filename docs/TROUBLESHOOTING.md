# Troubleshooting

Start with:

```bash
sudo noxctl doctor
sudo systemctl status vps-sentinel vps-sentinel-agent nginx
```

## Domain does not resolve

Create the DNS record before installation. For a public origin, DNS must resolve to the VPS public IP. For Cloudflare proxy mode, it may resolve to Cloudflare addresses.

## Certificate issuance fails

Confirm TCP/80 is reachable, the DNS record is correct and no other nginx vhost claims the hostname. Run:

```bash
sudo nginx -t
sudo certbot certificates
sudo journalctl -u nginx -n 100 --no-pager
```

## Dashboard opens but passkey fails

WebAuthn requires HTTPS and an exact match between the domain, `RP_ID` and `ORIGIN` in `/etc/vps-sentinel.env`. Do not access by IP or an alternate hostname.

## Filesystem index is unavailable

```bash
sudo journalctl -u vps-sentinel-agent -n 100 --no-pager
sudo ls -lh /var/lib/vps-sentinel/filesystem.json
```

The first index may take several seconds. Large technical trees and sensitive areas are excluded intentionally.

## No Telegram notifications

Check only whether variables are present, without printing values:

```bash
grep -E '^(SENTINEL_TELEGRAM_BOT_TOKEN|SENTINEL_TELEGRAM_CHAT_ID)=' /etc/vps-sentinel.env | cut -d= -f1
sudo sqlite3 /var/lib/vps-sentinel/sentinel.db 'select ts,success,detail from notifications order by id desc limit 10;'
```

## Update failed

`noxctl update` automatically restores the previous application if staging or health checks fail. Paths to state and app rollback archives are printed. Run `noxctl doctor` before retrying.

## High CPU in browser

Confirm the current release is installed, force-refresh once, and verify static cache headers. Charts use persisted SQLite data and no longer redraw on every realtime tick.
