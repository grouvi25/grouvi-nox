#!/usr/bin/env bash
set -Eeuo pipefail
archive=${1:-}; sums=${2:-}
[[ -f $archive && -f $sums ]] || { echo 'Usage: verify-release.sh <archive.tar.gz> <SHA256SUMS>' >&2; exit 1; }
expected=$(awk -v name="$(basename "$archive")" '$2==name {print $1}' "$sums")
[[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Archive is absent from SHA256SUMS.' >&2; exit 1; }
actual=$(sha256sum "$archive" | awk '{print $1}')
[[ $actual == "$expected" ]] || { echo "Checksum mismatch: expected $expected, got $actual" >&2; exit 1; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
[[ -f $work/package.json && -f $work/deploy/install.sh && -f $work/RELEASE-MANIFEST.json ]] || { echo 'Bundle structure invalid.' >&2; exit 1; }
node -e "const p=require('$work/package.json'),m=require('$work/RELEASE-MANIFEST.json');if(p.name!=='vps-sentinel'||m.package!==p.name)process.exit(1)"
find "$work" -type f \( -name '.env' -o -name '*.pem' -o -name '*.key' \) | grep -q . && { echo 'Forbidden secret-like files found.' >&2; exit 1; } || true
echo "Release verified: $(basename "$archive")"
echo "SHA256: $actual"
