# Path policy

VPS Sentinel has three path classes:

1. Product-owned defaults: `/opt/vps-sentinel`, `/var/lib/vps-sentinel`, `/etc/vps-sentinel.env`, `/run/vps-sentinel`. These are configurable through install metadata and environment variables.
2. Standard Linux discovery roots: `/opt`, `/srv`, `/var/www`, `/home`, `/root`. The setup wizard can replace this list. `/proc`, `/sys`, `/dev`, `/run`, Docker/containerd internals, `.ssh`, caches and quarantine directories are always excluded.
3. Host-specific targets: Git repositories, backups, databases, Compose projects, PM2 processes, domains and services. These must come from Discovery Engine or explicit installer overrides, never source-code constants.

CI rejects names and paths from the original development VPS to prevent accidental coupling.
