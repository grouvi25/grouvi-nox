#!/usr/bin/env bash
# Shared runtime for Grouvi Nox lifecycle commands.
set -Eeuo pipefail

SENTINEL_APP_DIR=${SENTINEL_APP_DIR:-/opt/vps-sentinel}
SENTINEL_STATE_DIR=${SENTINEL_STATE_DIR:-/var/lib/vps-sentinel}
SENTINEL_CONFIG=${SENTINEL_CONFIG:-/etc/vps-sentinel.env}
SENTINEL_INSTALL_CONFIG=${SENTINEL_INSTALL_CONFIG:-/etc/vps-sentinel/install.conf}
SENTINEL_USER=${SENTINEL_USER:-vpssentinel}
SENTINEL_SERVICE=${SENTINEL_SERVICE:-vps-sentinel}
SENTINEL_AGENT_SERVICE=${SENTINEL_AGENT_SERVICE:-vps-sentinel-agent}

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'; C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi

section(){ printf '\n%b==> %s%b\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
ok(){ printf '  %b✓%b %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn(){ printf '  %b!%b %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die(){ printf '  %b✗ %s%b\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }
info(){ printf '  %b·%b %s\n' "$C_DIM" "$C_RESET" "$*"; }

require_root(){ [[ ${EUID:-$(id -u)} -eq 0 ]] || die 'Run as root (sudo -i).'; }
need(){ command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

trim(){ local v=$*; v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}; printf '%s' "$v"; }
valid_domain(){ [[ $1 =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; }
valid_port(){ [[ $1 =~ ^[0-9]+$ ]] && ((1 <= 10#$1 && 10#$1 <= 65535)); }

read_os(){
  [[ -r /etc/os-release ]] || die 'Cannot identify operating system.'
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID=${ID:-unknown}; OS_VERSION=${VERSION_ID:-unknown}
}

supported_os(){
  read_os
  case "$OS_ID:$OS_VERSION" in
    ubuntu:22.04|ubuntu:24.04|debian:12) return 0 ;;
    *) return 1 ;;
  esac
}

service_exists(){ systemctl cat "$1" >/dev/null 2>&1; }
service_active(){ [[ $(systemctl is-active "$1" 2>/dev/null || true) == active ]]; }

atomic_write(){
  local target=$1 mode=${2:-600} owner=${3:-root:root} tmp
  tmp=$(mktemp "${target}.tmp.XXXXXX")
  cat > "$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$target"
}

backup_file(){
  local file=$1 dir=$2
  [[ -e $file || -L $file ]] || return 0
  mkdir -p "$dir$(dirname "$file")"
  cp -a "$file" "$dir$file"
}

wait_http(){
  local url=$1 tries=${2:-30} delay=${3:-2}
  for ((i=1;i<=tries;i++)); do
    curl -fsS --max-time 4 "$url" >/dev/null 2>&1 && return 0
    sleep "$delay"
  done
  return 1
}

load_install_config(){
  [[ -r $SENTINEL_INSTALL_CONFIG ]] || die "Install metadata missing: $SENTINEL_INSTALL_CONFIG"
  # shellcheck disable=SC1090
  . "$SENTINEL_INSTALL_CONFIG"
}

confirm(){
  local prompt=$1 reply
  [[ ${ASSUME_YES:-0} == 1 ]] && return 0
  read -r -p "$prompt [y/N] " reply
  [[ $reply == y || $reply == Y || $reply == yes || $reply == YES ]]
}

sha256_file(){ sha256sum "$1" | awk '{print $1}'; }

# --- host prerequisites ---------------------------------------------------
#
# One list, two callers. install.sh used to hardcode its apt line while
# `noxctl update` swapped application files only, so a release that introduced
# a system dependency reached new installs and silently skipped every existing
# one. Managed scanning shipped that way: hosts got the unit, the timer and the
# policy with no engine to run. Updates now converge on this list too.

SENTINEL_BASE_PACKAGES=(ca-certificates curl gnupg git nginx certbot python3-certbot-nginx acl rsync sqlite3 build-essential python3 python3-venv python3-pip)
SENTINEL_RKHUNTER_PACKAGES=(rkhunter)
SENTINEL_CLAMAV_PACKAGES=(clamav clamav-freshclam)

# ClamAV loads its entire signature set into memory. Below roughly 2.4G of RAM
# clamscan is OOM-killed on every run, and the database alone wants ~1G of disk.
# A small VPS is better served by rkhunter alone than by a scanner that cannot
# finish. Keep these in step with deploy/security-scan.sh.
SENTINEL_CLAMAV_MIN_TOTAL_MB=2400
SENTINEL_CLAMAV_MIN_DISK_MB=3000

host_total_memory_mb(){ awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf '0'; }
host_free_disk_mb(){ df -Pm "${1:-$SENTINEL_STATE_DIR}" 2>/dev/null | awk 'NR==2{printf "%d", $4}' || printf '0'; }

host_supports_clamav(){
  local mem disk
  mem=$(host_total_memory_mb); disk=$(host_free_disk_mb /var/lib)
  (( ${mem:-0} >= SENTINEL_CLAMAV_MIN_TOTAL_MB && ${disk:-0} >= SENTINEL_CLAMAV_MIN_DISK_MB ))
}

# Engines this host is expected to run: rkhunter always, ClamAV when it is
# already present or the host can actually carry it.
scanner_expected_engines(){
  local engines='rkhunter'
  if command -v clamscan >/dev/null 2>&1 || host_supports_clamav; then engines="clamav $engines"; fi
  printf '%s' "$engines"
}

scanners_present(){
  command -v rkhunter >/dev/null || return 1
  if [[ $(scanner_expected_engines) == *clamav* ]]; then
    command -v clamscan >/dev/null || return 1
    command -v freshclam >/dev/null || return 1
  fi
  return 0
}

package_installed(){ dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }

base_packages_present(){
  local pkg
  for pkg in "${SENTINEL_BASE_PACKAGES[@]}"; do package_installed "$pkg" || return 1; done
  return 0
}

# Idempotent and quiet: when nothing is missing it does not even touch apt, so
# calling it on every update costs nothing on a converged host.
ensure_packages(){
  local pkg missing=()
  for pkg in "$@"; do package_installed "$pkg" || missing+=("$pkg"); done
  (( ${#missing[@]} )) || return 0
  info "Installing missing packages: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null || return 1
}

ensure_scanner_packages(){
  ensure_packages "${SENTINEL_RKHUNTER_PACKAGES[@]}" || return 1
  if [[ $(scanner_expected_engines) == *clamav* ]]; then
    ensure_packages "${SENTINEL_CLAMAV_PACKAGES[@]}" || return 1
  else
    warn "ClamAV skipped: needs ${SENTINEL_CLAMAV_MIN_TOTAL_MB}M RAM and ${SENTINEL_CLAMAV_MIN_DISK_MB}M free disk, host has $(host_total_memory_mb)M and $(host_free_disk_mb /var/lib)M. rkhunter will run alone."
  fi
}

ensure_prerequisites(){
  ensure_packages "${SENTINEL_BASE_PACKAGES[@]}" || return 1
  ensure_scanner_packages || return 1
}

json_escape(){
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}
