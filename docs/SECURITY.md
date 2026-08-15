# Security

## Fleet transport

- Each node uses a unique HMAC-SHA256 secret; secrets are never sent over the wire.
- Requests include a timestamp and random nonce. The hub rejects stale and replayed requests.
- Ingest is capped by payload size and per-node/source-IP rate limits.
- `FLEET_ALLOWED_IPS` can restrict the hub to known node addresses.
- During rotation, a hub may accept `["current-secret","previous-secret"]` for a node. Remove the previous value after every node has switched.
- The hub receives sanitized telemetry only, never SSH keys, Docker sockets, passkeys or file contents.

## Supply chain

- CI runs CodeQL, runtime dependency audit, dependency review and credential-pattern checks.
- Release archives are reproducible, checksummed and receive GitHub provenance attestations.
- Runtime updates verify the release checksum and roll back on failed health checks.

## Service sandbox

Both systemd services use `NoNewPrivileges`; the web process is unprivileged, loopback-only and writable only to its state directory. The root collector has no public listener and remains constrained by systemd filesystem, namespace, device and resource controls.

# Security model model

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

GitHub tag builds create a reproducible tarball and SHA-256 manifest. Public repositories also receive a GitHub build-provenance attestation; GitHub does not offer attestations for user-owned private repositories. Operators verify the downloaded archive before extraction. `noxctl update` requires the expected checksum and performs package-identity checks.

## Secrets

Runtime secrets live only in `/etc/vps-sentinel.env` (root, mode 0600). Telegram tokens never enter the database, browser payload, logs or release bundle. Service log drill-down applies defensive redaction to common secret formats.

## Origin modes

- `public`: normal nginx HTTPS origin.
- `cloudflare`: validates Cloudflare's current signed HTTPS IP lists during installation, restores the real client IP and rejects direct non-Cloudflare peers. If the IP list cannot be downloaded, installation fails closed.

## Remaining host-level trust


## Malware and rootkit scanning

ClamAV and rkhunter run as `vps-sentinel-security.service`, a oneshot unit driven by a timer, never by the web process. The unit is nice 19, idle I/O, capped at 25% CPU and 2400M, and runs under `ProtectSystem=strict` with write access only to the state directory and ClamAV's own paths. `flock` keeps concurrent runs out. Reports and logs land in `/var/lib/vps-sentinel/security-scans`, ten runs are retained.

The dashboard can start, stop and reschedule a scan through the same Unix-socket broker as the other integrations; it cannot install packages or run arbitrary commands.

The package list lives once, in `deploy/lib/common.sh`. `install.sh` and `noxctl update` both converge on it, so a release that adds a system dependency reaches hosts installed before it existed. Managed scanning originally shipped its unit, timer and policy to every updated host and its engines to none of them; that class of gap is what the shared list closes. `noxctl scan-setup` installs the engines on demand, and `noxctl doctor` reports anything still missing.

**ClamAV is not installed everywhere.** It loads its entire signature set into memory, so below 2400M of RAM or 3000M of free disk it is OOM-killed on every run. On such a host the installer skips it and rkhunter runs alone. That is a configuration, not a fault: the scan does not report `unavailable` for an engine the host was never expected to carry, and the dashboard says the engine was skipped rather than pointing at an install command that would not help. Installing ClamAV by hand on such a host makes it expected again.

A scan reports `unavailable`, never `clean`, when an *expected* engine is missing or was killed by the kernel, and the report names what did not run. Treat `clean` as meaningful only against the engine set the report says was expected.

## Incident response

A compromised host cannot be made trustworthy by reinstalling the dashboard. Rebuild the VPS from a clean image, rotate secrets and restore only verified application code plus database dumps.

## Docker isolation

The web process has no Docker group membership and cannot open `/var/run/docker.sock`. The root collector exposes a Unix socket owned by `vpssentinel` and accepts only a fixed set of Docker GET endpoints for list, disk usage, inspect, one-shot stats and redacted log tails. Mutation endpoints and path traversal are rejected. `noxctl doctor` verifies this boundary.

## Settings and secret integrations

`/settings` sends Telegram and AI credentials over authenticated same-origin HTTPS to a schema-limited Unix-socket broker. The unprivileged web process never writes system configuration. The root sidecar validates formats, updates only the allowlisted env/YAML fields, preserves ownership and file modes, then restarts only the affected service. API responses return masks and counts, never secret values.
