#!/usr/bin/env bash
set -Eeuo pipefail
archive=${1:?archive required}; sums=${2:?SHA256SUMS required}
[[ -f $archive && -f $sums ]] || { echo 'Release files missing.' >&2; exit 1; }
name=$(basename "$archive")
expected=$(awk -v name="$name" '$2==name{print $1}' "$sums")
[[ $expected =~ ^[a-f0-9]{64}$ ]] || { echo "Checksum missing for $name" >&2; exit 1; }
actual=$(sha256sum "$archive"|awk '{print $1}');[[ $actual == "$expected" ]]||{ echo 'Checksum mismatch.' >&2;exit 1; }
work=$(mktemp -d);trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
[[ -f $work/package.json && -f $work/RELEASE-MANIFEST.json && -f $work/src/server.js ]]||{ echo 'Invalid bundle.' >&2;exit 1; }
node -e "const p=require('$work/package.json'),m=require('$work/RELEASE-MANIFEST.json');if(!p.name.startsWith('grouvi-nox')||m.product!=='Grouvi Nox'||m.package!==p.name)process.exit(1)"
! find "$work" -type f \( -name '.env' -o -name '*.pem' -o -name 'id_rsa' -o -name 'id_ed25519' \) | grep -q .
echo "Verified $name"
