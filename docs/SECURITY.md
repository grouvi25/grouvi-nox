# Security model

## Trust boundaries

The internet-facing process runs as `vpssentinel`, listens only on loopback and cannot execute commands. The root collector has no network listener and emits bounded JSON metadata. Browser access requires a passkey with user verification.

## Read-only guarantees

The web API supports metric reads, metadata-only filesystem browsing, incident acknowledgement/closure and session operations. It provides no shell, file-content endpoint, container restart, process restart, package manager or arbitrary command interface.

Filesystem indexing explicitly excludes:

- SSH private areas
- malware quarantine paths
- Docker/containerd internals
- `.git`, `node_modules` and caches

Only metadata is indexed: path, type, size, permissions, ownership and modification time.

## Release integrity

GitHub tag builds create a reproducible tarball and SHA-256 manifest. Public repositories also receive a GitHub build-provenance attestation; GitHub does not offer attestations for user-owned private repositories. Operators verify the downloaded archive before extraction. `sentinelctl update` requires the expected checksum and performs package-identity checks.

## Secrets

Runtime secrets live only in `/etc/vps-sentinel.env` (root, mode 0600). Telegram tokens never enter the database, browser payload, logs or release bundle. Service log drill-down applies defensive redaction to common secret formats.

## Origin modes

- `public`: normal nginx HTTPS origin.
- `cloudflare`: validates Cloudflare's current signed HTTPS IP lists during installation, restores the real client IP and rejects direct non-Cloudflare peers. If the IP list cannot be downloaded, installation fails closed.

## Remaining host-level trust

Container visibility requires membership in the Docker group, which is root-equivalent on Linux. The web process therefore has Docker-socket read access and must be treated as sensitive. For high-assurance environments, place a read-only Docker socket proxy in front of the daemon and remove direct group membership.

## Incident response

A compromised host cannot be made trustworthy by reinstalling the dashboard. Rebuild the VPS from a clean image, rotate secrets and restore only verified application code plus database dumps.

## Docker isolation

The web process has no Docker group membership and cannot open `/var/run/docker.sock`. The root collector exposes a Unix socket owned by `vpssentinel` and accepts only a fixed set of Docker GET endpoints for list, disk usage, inspect, one-shot stats and redacted log tails. Mutation endpoints and path traversal are rejected. `sentinelctl doctor` verifies this boundary.
