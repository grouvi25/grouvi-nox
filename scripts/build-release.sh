#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-v$(node -p "require('$ROOT/package.json').version")}
OUT=${2:-$ROOT/dist}
[[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "Invalid version: $VERSION" >&2; exit 1; }
package_version=$(node -p "require('$ROOT/package.json').version")
[[ $VERSION == "v$package_version" ]] || { echo "Tag $VERSION does not match package version $package_version" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/stage"

# Explicit allowlist: release contents cannot accidentally absorb .env, keys,
# coverage, local state, node_modules or forensic artifacts.
for item in package.json package-lock.json README.md LICENSE RELEASE-MANIFEST.json .env.example bin deploy docs public scripts src tests; do
  [[ -e $ROOT/$item ]] || { echo "Required release item missing: $item" >&2; exit 1; }
  cp -a "$ROOT/$item" "$OUT/stage/"
done
find "$OUT/stage" -type f -name '*.env' -o -name '.env' | grep -q . && { echo 'Secret-like env file entered release stage.' >&2; exit 1; } || true
find "$OUT/stage" -type f -exec chmod 644 {} +
chmod 755 "$OUT/stage/deploy/install.sh" "$OUT/stage/bin/sentinelctl" "$OUT/stage/bin/enroll.js" "$OUT/stage/bin/privileged-collector.js"
find "$OUT/stage/deploy" -type f -name '*.sh' -exec chmod 755 {} +

archive="$OUT/vps-sentinel-$VERSION-linux.tar.gz"
# Stable ordering, timestamps and ownership make the archive reproducible.
tar --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner -C "$OUT/stage" -czf "$archive" .
(
  cd "$OUT"
  sha256sum "$(basename "$archive")" > SHA256SUMS
)
rm -rf "$OUT/stage"
printf 'Built %s\nSHA256 %s\n' "$archive" "$(sha256sum "$archive" | awk '{print $1}')"
