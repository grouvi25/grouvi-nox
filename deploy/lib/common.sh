#!/usr/bin/env bash
# Shared runtime for VPS Sentinel lifecycle commands.
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

json_escape(){
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}
