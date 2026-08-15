#!/usr/bin/env bash
# Grouvi Nox production installer
# Supported: Ubuntu 22.04/24.04, Debian 12; x86_64/aarch64.
# Safe to re-run. Existing state is preserved and config is backed up.
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SOURCE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

DOMAIN=${DOMAIN:-}
LE_EMAIL=${LE_EMAIL:-}
PROXY_MODE=${PROXY_MODE:-public}
PORT=${PORT:-3999}
BACKUP_DIRS=${BACKUP_DIRS:-}
DEPLOY_DIRS=${DEPLOY_DIRS:-}
TELEGRAM_TOKEN=${TELEGRAM_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
SENTINEL_ROLE=${SENTINEL_ROLE:-standalone}
FLEET_NODE_ID=${FLEET_NODE_ID:-}
FLEET_NODE_NAME=${FLEET_NODE_NAME:-}
FLEET_HUB_URL=${FLEET_HUB_URL:-}
FLEET_SHARED_SECRET=${FLEET_SHARED_SECRET:-}
FLEET_NODES_JSON=${FLEET_NODES_JSON:-}
[[ -n $FLEET_NODES_JSON ]] || FLEET_NODES_JSON='{}'
FLEET_ALLOWED_IPS=${FLEET_ALLOWED_IPS:-}
NON_INTERACTIVE=0
ASSUME_YES=0
SKIP_DNS_CHECK=0
CONFIGURE_UFW=0
NO_RECOVERY_CODES=0
INSTALL_FORGE=1
AI_BASE_URL=${AI_BASE_URL:-https://api.example.com/v1}
AI_MODEL=${AI_MODEL:-Qwen3.6-35B-A3B}
AI_FALLBACK_MODEL=${AI_FALLBACK_MODEL:-DeepSeek-V4-Pro}
AI_PROVIDER_LABEL=${AI_PROVIDER_LABEL:-OpenAI compatible}
AI_API_KEY=${AI_API_KEY:-}
AI_BACKUP_KEYS=${AI_BACKUP_KEYS:-}
DRY_RUN=0

usage(){ cat <<'EOF'
Grouvi Nox production installer

Usage:
  sudo ./deploy/install.sh --domain monitor.example.com --email ops@example.com [options]

Required:
  --domain NAME             Public HTTPS hostname used by WebAuthn
  --email ADDRESS           Let's Encrypt registration/expiry email

Options:
  --proxy public|cloudflare Public origin, or locked to Cloudflare edge IPs
  --port PORT               Internal loopback port (default: 3999)
  --backup-dirs CSV         Read-only backup folders to monitor
  --deploy-dirs CSV         Git repositories shown in deployment timeline
  --telegram-token TOKEN    Optional Telegram bot token
  --telegram-chat-id ID     Optional Telegram destination
  --role MODE               standalone, hub or node
  --node-id ID              Stable fleet node identifier
  --node-name NAME          Human-readable server name
  --hub-url URL             HTTPS hub URL used by a node
  --fleet-secret SECRET     Unique 32+ byte HMAC secret
  --fleet-nodes-json JSON   Hub map: node ID to secret or [current,previous]
  --fleet-allowed-ips CSV   Optional hub source-IP allowlist
  --without-forge           Skip isolated Hermes/Nox Forge installation
  --ai-base-url URL         OpenAI-compatible HTTPS endpoint
  --ai-model NAME           Primary Forge model
  --ai-fallback-model NAME  Fallback Forge model
  --ai-provider-label NAME  Provider label shown in settings
  --ai-key KEY              Optional primary provider key (or configure later)
  --ai-backup-keys CSV      Optional provider fallback keys
  --configure-ufw           Allow SSH, HTTP and HTTPS if UFW is installed
  --skip-dns-check          Continue if DNS validation cannot be completed
  --no-recovery-codes       Do not print recovery codes during install
  --dry-run                 Validate host and print plan; change nothing
  --non-interactive         Never prompt; missing values are fatal
  -y, --yes                 Accept installation plan
  -h, --help                Show help

Security:
  Download a release archive and SHA256SUMS separately. Verify with
  `sha256sum -c SHA256SUMS`, extract, then run this local installer.
  Never install Grouvi Nox via `curl | sh`.
EOF
}

while (($#)); do
  case $1 in
    --domain) DOMAIN=${2:-}; shift 2;; --email) LE_EMAIL=${2:-}; shift 2;;
    --proxy) PROXY_MODE=${2:-}; shift 2;; --port) PORT=${2:-}; shift 2;;
    --backup-dirs) BACKUP_DIRS=${2:-}; shift 2;; --deploy-dirs) DEPLOY_DIRS=${2:-}; shift 2;;
    --telegram-token) TELEGRAM_TOKEN=${2:-}; shift 2;; --telegram-chat-id) TELEGRAM_CHAT_ID=${2:-}; shift 2;;
    --role) SENTINEL_ROLE=${2:-}; shift 2;; --node-id) FLEET_NODE_ID=${2:-}; shift 2;;
    --node-name) FLEET_NODE_NAME=${2:-}; shift 2;; --hub-url) FLEET_HUB_URL=${2:-}; shift 2;;
    --fleet-secret) FLEET_SHARED_SECRET=${2:-}; shift 2;; --fleet-nodes-json) FLEET_NODES_JSON=${2:-}; shift 2;;
    --fleet-allowed-ips) FLEET_ALLOWED_IPS=${2:-}; shift 2;;
    --without-forge) INSTALL_FORGE=0; shift;; --ai-base-url) AI_BASE_URL=${2:-}; shift 2;; --ai-model) AI_MODEL=${2:-}; shift 2;;
    --ai-fallback-model) AI_FALLBACK_MODEL=${2:-}; shift 2;; --ai-provider-label) AI_PROVIDER_LABEL=${2:-}; shift 2;; --ai-key) AI_API_KEY=${2:-}; shift 2;; --ai-backup-keys) AI_BACKUP_KEYS=${2:-}; shift 2;;
    --configure-ufw) CONFIGURE_UFW=1; shift;; --skip-dns-check) SKIP_DNS_CHECK=1; shift;;
    --no-recovery-codes) NO_RECOVERY_CODES=1; shift;; --dry-run) DRY_RUN=1; shift;; --non-interactive) NON_INTERACTIVE=1; shift;;
    -y|--yes) ASSUME_YES=1; shift;; -h|--help) usage; exit 0;; *) usage; die "Unknown option: $1";;
  esac
done
export ASSUME_YES
require_root

prompt_value(){
  local var=$1 prompt=$2 secret=${3:-0} current value
  current=${!var:-}
  [[ -n $current ]] && return 0
  ((NON_INTERACTIVE)) && die "Missing required option: $var"
  if ((secret)); then read -r -s -p "$prompt: " value; echo; else read -r -p "$prompt: " value; fi
  printf -v "$var" '%s' "$(trim "$value")"
}

prompt_value DOMAIN 'Dashboard domain (for example monitor.example.com)'
prompt_value LE_EMAIL "Let's Encrypt email"
valid_domain "$DOMAIN" || die "Invalid domain: $DOMAIN"
[[ $LE_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'Invalid email address.'
valid_port "$PORT" || die "Invalid port: $PORT"
[[ $PROXY_MODE == public || $PROXY_MODE == cloudflare ]] || die '--proxy must be public or cloudflare.'
[[ $SENTINEL_ROLE == standalone || $SENTINEL_ROLE == hub || $SENTINEL_ROLE == node ]] || die '--role must be standalone, hub or node.'
if [[ $SENTINEL_ROLE == node ]]; then
  [[ $FLEET_NODE_ID =~ ^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$ ]] || die 'Node mode requires a valid --node-id.'
  [[ $FLEET_HUB_URL =~ ^https:// ]] || die 'Node mode requires an HTTPS --hub-url.'
  [[ ${#FLEET_SHARED_SECRET} -ge 32 ]] || die 'Node mode requires a 32+ byte --fleet-secret.'
fi
if [[ $SENTINEL_ROLE == hub ]]; then
  [[ $FLEET_NODES_JSON == \{*\} ]] || die 'Hub mode requires valid --fleet-nodes-json.'
fi
((INSTALL_FORGE==0)) || [[ $AI_BASE_URL == https://* ]] || die '--ai-base-url must use HTTPS.'
[[ -f $SOURCE_DIR/package.json && -f $SOURCE_DIR/RELEASE-MANIFEST.json ]] || die 'Run installer from an extracted Grouvi Nox release.'

section 'Preflight'
supported_os || die "Unsupported OS: ${OS_ID:-unknown} ${OS_VERSION:-unknown}. Supported: Ubuntu 22.04/24.04, Debian 12."
arch=$(uname -m); [[ $arch == x86_64 || $arch == aarch64 ]] || die "Unsupported architecture: $arch"
ok "$PRETTY_NAME, $arch"
[[ $(systemd-detect-virt --container 2>/dev/null || true) == none || -z $(systemd-detect-virt --container 2>/dev/null || true) ]] || die 'Install on a VPS host, not inside a container.'

if ss -H -lnt | awk '{print $4}' | grep -Eq "(^|:)${PORT}$" && ! service_active "$SENTINEL_SERVICE"; then
  die "Port $PORT is already in use. Pick another with --port."
fi

resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
[[ -n $resolved ]] && ok "DNS resolves: $resolved" || { ((SKIP_DNS_CHECK)) && warn 'DNS does not resolve yet; continuing by request.' || die "DNS does not resolve for $DOMAIN. Create the record first or use --skip-dns-check."; }
if [[ $PROXY_MODE == public && -n $resolved && $SKIP_DNS_CHECK -eq 0 ]]; then
  public_ip=$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  [[ -z $public_ip || " $resolved " == *" $public_ip "* ]] || die "DNS points to '$resolved', but this VPS public IPv4 is '$public_ip'."
fi

# Empty backup/deploy lists are intentional: Discovery Engine manages them after first login.

section 'Installation plan'
printf '  Domain:          %s\n  Proxy mode:      %s\n  Internal port:   %s\n  Install path:    %s\n  State path:      %s\n  Backup folders:  %s\n  Git repositories:%s\n  Telegram:        %s\n  Nox Forge:  %s\n  AI provider:     %s\n' \
  "$DOMAIN" "$PROXY_MODE" "$PORT" "$SENTINEL_APP_DIR" "$SENTINEL_STATE_DIR" \
  "${BACKUP_DIRS:- none}" "${DEPLOY_DIRS:+ }${DEPLOY_DIRS:- none}" "$([[ -n $TELEGRAM_TOKEN && -n $TELEGRAM_CHAT_ID ]] && echo enabled || echo disabled)" \
  "$([[ $INSTALL_FORGE -eq 1 ]] && echo installed || echo skipped)" "$([[ -n $AI_API_KEY ]] && echo configured || echo dashboard-setup)"
if ((DRY_RUN)); then
  ok 'Dry-run complete. Host and configuration are valid; no changes made.'
  exit 0
fi
confirm 'Proceed with this plan?' || die 'Cancelled.'

section 'System packages'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq "${SENTINEL_BASE_PACKAGES[@]}" >/dev/null
ensure_scanner_packages || die 'Could not install the security scanners.'
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if ((node_major < 20)); then
  info 'Installing signed Node.js 20 apt repository (no remote shell execution).'
  install -d -m 755 /etc/apt/keyrings
  key_tmp=$(mktemp); curl -fsS --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_tmp"
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg "$key_tmp"; rm -f "$key_tmp"
  chmod 644 /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main\n' > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq; apt-get install -y -qq nodejs >/dev/null
fi
node_major=$(node -p 'process.versions.node.split(".")[0]'); ((node_major >= 20)) || die 'Node.js 20 installation failed.'
ok "Node.js $(node -v), nginx $(nginx -v 2>&1 | cut -d/ -f2)"

section 'Backup existing installation'
pre_backup=/root/vps-sentinel-preinstall-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$pre_backup"
backup_file "$SENTINEL_CONFIG" "$pre_backup"; backup_file "$SENTINEL_INSTALL_CONFIG" "$pre_backup"
backup_file /etc/nginx/sites-available/vps-sentinel "$pre_backup"
[[ -d $SENTINEL_STATE_DIR ]] && cp -a "$SENTINEL_STATE_DIR" "$pre_backup/state" || true
ok "Backup: $pre_backup"

section 'Application'
if ! id "$SENTINEL_USER" >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin "$SENTINEL_USER"; fi
getent group adm >/dev/null && usermod -aG adm "$SENTINEL_USER"
getent group docker >/dev/null && gpasswd -d "$SENTINEL_USER" docker >/dev/null 2>&1 || true
install -d -m 700 -o "$SENTINEL_USER" -g "$SENTINEL_USER" "$SENTINEL_STATE_DIR"
if [[ $(readlink -f "$SOURCE_DIR") != $(readlink -f "$SENTINEL_APP_DIR" 2>/dev/null || echo missing) ]]; then
  install -d -m 755 -o root -g root "$SENTINEL_APP_DIR"
  rsync -a --delete --exclude .git --exclude node_modules "$SOURCE_DIR/" "$SENTINEL_APP_DIR/"
fi
cd "$SENTINEL_APP_DIR"; npm ci --omit=dev --no-audit --no-fund
chown -R root:root "$SENTINEL_APP_DIR"; chmod -R go-w "$SENTINEL_APP_DIR"
install -m 755 bin/noxctl /usr/local/sbin/noxctl
install -m 755 bin/sentinelctl /usr/local/sbin/sentinelctl
ok "Installed version $(node -p "require('./package.json').version")"

section 'Read-only data access'
if [[ -n $BACKUP_DIRS ]]; then
  IFS=',' read -ra dirs <<< "$BACKUP_DIRS"
  for dir in "${dirs[@]}"; do dir=$(trim "$dir"); [[ -d $dir ]] || continue; setfacl -m "u:${SENTINEL_USER}:x" "$(dirname "$dir")" 2>/dev/null || true; setfacl -m "u:${SENTINEL_USER}:rx" "$dir" 2>/dev/null || true; done
fi
ok 'Metadata-only filesystem index; sensitive trees excluded by policy.'

section 'Configuration'
install -d -m 700 -o root -g root /etc/vps-sentinel
cat > "$SENTINEL_CONFIG" <<EOF
NODE_ENV=production
PORT=$PORT
HOST=127.0.0.1
RP_ID=$DOMAIN
ORIGIN=https://$DOMAIN
RP_NAME=Grouvi Nox
STATE_DIR=$SENTINEL_STATE_DIR
BACKUP_DIRS=$BACKUP_DIRS
DEPLOY_DIRS=$DEPLOY_DIRS
HISTORY_PERSIST_INTERVAL_MS=10000
HISTORY_RETENTION_DAYS=30
INCIDENT_RESOLVE_GRACE_MS=45000
SENTINEL_ROLE=$SENTINEL_ROLE
FLEET_NODE_ID=$FLEET_NODE_ID
FLEET_NODE_NAME=$FLEET_NODE_NAME
FLEET_HUB_URL=$FLEET_HUB_URL
FLEET_SHARED_SECRET=$FLEET_SHARED_SECRET
FLEET_NODES_JSON=$FLEET_NODES_JSON
FLEET_ALLOWED_IPS=$FLEET_ALLOWED_IPS
FLEET_PUSH_INTERVAL_MS=10000
FLEET_OFFLINE_AFTER_MS=45000
FLEET_MAX_SNAPSHOT_BYTES=524288
FLEET_INGEST_PER_MINUTE=30
SENTINEL_RELEASE_REPO=grouvi25/grouvi-nox
UPDATE_CHECK_INTERVAL_MS=600000
UPDATE_FRESHNESS_MS=60000
TELEGRAM_COOLDOWN_MIN=30
DISCOVERY_ROOTS=${DISCOVERY_ROOTS:-/opt,/srv,/var/www,/home,/root}
DISCOVERY_INTERVAL_MS=900000
SENTINEL_PROXY_MODE=$PROXY_MODE
LE_EMAIL=$LE_EMAIL
FS_INDEX_INTERVAL_MS=1800000
FS_MAX_ENTRIES=60000
SENTINEL_TELEGRAM_BOT_TOKEN=$TELEGRAM_TOKEN
SENTINEL_TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
EOF
chmod 600 "$SENTINEL_CONFIG"; chown root:root "$SENTINEL_CONFIG"
cat > "$SENTINEL_INSTALL_CONFIG" <<EOF
DOMAIN='$DOMAIN'
LE_EMAIL='$LE_EMAIL'
PROXY_MODE='$PROXY_MODE'
PORT='$PORT'
APP_DIR='$SENTINEL_APP_DIR'
STATE_DIR='$SENTINEL_STATE_DIR'
BACKUP_DIRS='$BACKUP_DIRS'
DEPLOY_DIRS='$DEPLOY_DIRS'
INSTALL_FORGE='$INSTALL_FORGE'
INSTALLED_AT='$(date -u +%FT%TZ)'
EOF
chmod 600 "$SENTINEL_INSTALL_CONFIG"; chown root:root "$SENTINEL_INSTALL_CONFIG"
ok 'Secrets stored root-only in /etc/vps-sentinel.env.'

section 'Nginx base configuration'
install -d -m 755 /etc/nginx/snippets /etc/nginx/conf.d /var/www/vps-sentinel-acme
install -m 644 deploy/sentinel-proxy.conf /etc/nginx/snippets/sentinel-proxy.conf
cat > /etc/nginx/conf.d/vps-sentinel-http.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
limit_req_zone $binary_remote_addr zone=sentinel_auth:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=sentinel_all:10m rate=240r/m;
EOF
REALIP_INCLUDE=''
ORIGIN_GUARD=''
if [[ $PROXY_MODE == cloudflare ]]; then
  ipv4=$(mktemp); ipv6=$(mktemp)
  curl -fsS --proto '=https' --tlsv1.2 https://www.cloudflare.com/ips-v4 -o "$ipv4"
  curl -fsS --proto '=https' --tlsv1.2 https://www.cloudflare.com/ips-v6 -o "$ipv6"
  [[ -s $ipv4 ]] || die 'Cloudflare IP list download failed; refusing to leave origin open.'
  {
    echo 'geo $realip_remote_addr $sentinel_cf_peer { default 0; 127.0.0.1 1; ::1 1;'
    while read -r cidr; do [[ -n $cidr ]] && printf '  %s 1;\n' "$cidr"; done < "$ipv4"
    while read -r cidr; do [[ -n $cidr ]] && printf '  %s 1;\n' "$cidr"; done < "$ipv6"
    echo '}'
  } > /etc/nginx/conf.d/vps-sentinel-cloudflare-geo.conf
  {
    while read -r cidr; do [[ -n $cidr ]] && printf 'set_real_ip_from %s;\n' "$cidr"; done < "$ipv4"
    while read -r cidr; do [[ -n $cidr ]] && printf 'set_real_ip_from %s;\n' "$cidr"; done < "$ipv6"
    echo 'real_ip_header CF-Connecting-IP;'; echo 'real_ip_recursive on;'
  } > /etc/nginx/snippets/vps-sentinel-cloudflare-realip.conf
  rm -f "$ipv4" "$ipv6"
  REALIP_INCLUDE='    include /etc/nginx/snippets/vps-sentinel-cloudflare-realip.conf;'
  ORIGIN_GUARD='    if ($sentinel_cf_peer = 0) { return 403; }'
else
  rm -f /etc/nginx/conf.d/vps-sentinel-cloudflare-geo.conf /etc/nginx/snippets/vps-sentinel-cloudflare-realip.conf
fi

# HTTP-only bootstrap for ACME.
cat > /etc/nginx/sites-available/vps-sentinel <<EOF
server {
  listen 80; listen [::]:80; server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/vps-sentinel-acme; }
  location / { return 404; }
}
EOF
ln -sf /etc/nginx/sites-available/vps-sentinel /etc/nginx/sites-enabled/vps-sentinel
nginx -t; systemctl enable --now nginx; systemctl reload nginx

section 'TLS certificate'
certbot certonly --webroot -w /var/www/vps-sentinel-acme -d "$DOMAIN" -m "$LE_EMAIL" --non-interactive --agree-tos --keep-until-expiring
ok "Certificate: /etc/letsencrypt/live/$DOMAIN"

section 'Nginx HTTPS site'
ngx_ver=$(nginx -v 2>&1 | sed 's#nginx/##'); ngx_minor=$(echo "$ngx_ver" | cut -d. -f2)
HTTP2_LISTEN=''; HTTP2_DIRECTIVE='    http2 on;'
if [[ ${ngx_minor:-0} -lt 25 ]]; then HTTP2_LISTEN=' http2'; HTTP2_DIRECTIVE=''; fi
python3 - "$DOMAIN" "$PORT" "$HTTP2_LISTEN" "$HTTP2_DIRECTIVE" "$REALIP_INCLUDE" "$ORIGIN_GUARD" <<'PY'
import pathlib,sys
src=pathlib.Path('deploy/templates/nginx.conf').read_text()
keys=['DOMAIN','PORT','HTTP2_LISTEN','HTTP2_DIRECTIVE','REALIP_INCLUDE','ORIGIN_GUARD']
for key,value in zip(keys,sys.argv[1:]): src=src.replace(f'@@{key}@@',value)
pathlib.Path('/etc/nginx/sites-available/vps-sentinel').write_text(src)
PY
nginx -t; systemctl reload nginx
ok "https://$DOMAIN"

section 'systemd services'
install -m 644 deploy/vps-sentinel.service "/etc/systemd/system/${SENTINEL_SERVICE}.service"
install -m 644 deploy/vps-sentinel-agent.service "/etc/systemd/system/${SENTINEL_AGENT_SERVICE}.service"
install -m 644 deploy/vps-sentinel-security.service /etc/systemd/system/vps-sentinel-security.service
install -m 644 deploy/vps-sentinel-security.timer /etc/systemd/system/vps-sentinel-security.timer
chmod 755 "$SENTINEL_APP_DIR/deploy/security-scan.sh"
install -d -m 750 -o root -g "$SENTINEL_USER" "$SENTINEL_STATE_DIR/security-scans"
if [[ ! -f $SENTINEL_STATE_DIR/security-scan-policy.json ]]; then printf '%s\n' '{"schema":1,"enabled":true,"frequency":"weekly"}' > "$SENTINEL_STATE_DIR/security-scan-policy.json"; fi
chown root:"$SENTINEL_USER" "$SENTINEL_STATE_DIR/security-scan-policy.json"; chmod 640 "$SENTINEL_STATE_DIR/security-scan-policy.json"
systemctl daemon-reload
systemctl enable --now "$SENTINEL_AGENT_SERVICE" "$SENTINEL_SERVICE" vps-sentinel-security.timer
for _ in {1..30}; do [[ -s $SENTINEL_STATE_DIR/discovery.json ]] && break; sleep 1; done
[[ -s $SENTINEL_STATE_DIR/discovery.json ]] || warn 'Initial discovery is still running; the setup wizard can rescan.'
wait_http "http://127.0.0.1:${PORT}/healthz" 40 2 || { journalctl -u "$SENTINEL_SERVICE" -n 100 --no-pager; die 'Service failed health check.'; }

if ((INSTALL_FORGE)); then
  section 'Nox Forge and Hermes'
  AI_BASE_URL="$AI_BASE_URL" AI_MODEL="$AI_MODEL" AI_FALLBACK_MODEL="$AI_FALLBACK_MODEL" AI_PROVIDER_LABEL="$AI_PROVIDER_LABEL" AI_API_KEY="$AI_API_KEY" AI_BACKUP_KEYS="$AI_BACKUP_KEYS" ./deploy/install-forge.sh
  systemctl restart "$SENTINEL_AGENT_SERVICE" "$SENTINEL_SERVICE"
  wait_http "http://127.0.0.1:${PORT}/healthz" 30 2 || die 'Core service failed after Forge integration.'
fi

if ((CONFIGURE_UFW)) && command -v ufw >/dev/null 2>&1; then
  section 'Firewall'
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null; ok 'UFW enabled for SSH/HTTP/HTTPS.'
fi

section 'Verification'
noxctl doctor || die 'Installation completed, but doctor found errors.'
section 'First access'
node bin/enroll.js 'initial-install'
if ((!NO_RECOVERY_CODES)); then node bin/enroll.js --recovery; fi
ok 'Installation completed.'
forge_state=$([[ $INSTALL_FORGE -eq 1 ]] && echo installed || echo skipped)
printf '\n  Dashboard: https://%s\n  Control:   sudo noxctl status\n  Diagnose:  sudo noxctl doctor\n  Forge:     %s\n  Backup:    sudo noxctl backup\n\n' "$DOMAIN" "$forge_state"
