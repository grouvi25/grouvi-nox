# Agent-proposed changes

Nox Forge can look at the server and propose changes: edit a project, replace a
config file, restart containers, run a migration. **It can never apply any of
it.** The operator reviews the exact diff or command in the dashboard and
approves it with a passkey. A small root service then applies it, journals it
and can undo it.

Off by default. Nothing in this document is active until:

```bash
noxctl changes enable
```

## How a change travels

```
Hermes (user sentinel-ai) ── nox-propose ──► /var/lib/sentinel-ai/proposals/*.json
        │ nox-probe (read only) ──► probe socket ─► broker (root)
        ▼
Dashboard ── lists proposals, shows the exact diff/command ──► you tap your passkey
        │  challenge = sha256(purpose, proposal hash, one-time nonce)
        ▼
change broker (root, vps-sentinel-changes) ── verifies the signature ITSELF ──► applies
        │  snapshot → apply → post steps → health check → (auto rollback on failure)
        ▼
journal (hash chain) + Telegram copy
```

* **Proposals** are produced by `nox-propose`. For a `patch` the diff is generated
  from the agent's own checkout by git, so what you review is what git says
  changed. Kinds: `patch` (project files), `file` (replace one file, with an
  optional validate command such as `nginx -t`), `command` (anything, including
  restarting containers).
* **Safety nets** the agent can attach: `--post` (restart exactly what the change
  needs), `--health-url` / `--health-cmd` (a failed check rolls the change back
  automatically and re-runs the restart), `--undo` (for commands that have an
  inverse).
* **Rollback** of a patch or file is exact and refuses to overwrite edits made
  after the change unless you force it. Rolling back also needs a passkey tap.
* **Probes** (`nox-probe -- docker ps`) are reads only: logs, status, listings.
  Anything that is not plainly a read is refused, credentials are scrubbed from
  the output, and files that hold secrets are unreachable, including through
  symlinks.

## Two tiers, one tap

Every apply and rollback needs a passkey tap. The tiers only decide how loudly
the dashboard warns you:

| Tier | Examples | Shown as |
|---|---|---|
| routine | restart a container, `docker compose up -d --build`, edit app code or an nginx site, `rm -rf node_modules` | normal card |
| dangerous | firewall, SSH, users, disk tools, recursive deletes outside project junk, `docker system prune`, `git reset --hard`, editing systemd units or other startup files, anything touching Nox itself, text with hidden control characters | red "опасное" badge, reason listed, Telegram marks it |

Nothing is *refused* for being powerful. Restarting containers and rewriting
configs is the point.

## Threat model

| Attack | Why it does not work |
|---|---|
| Stolen session cookie, CSRF, open tab | Applying needs a fresh passkey signature, verified by the root broker, not by the web service |
| Compromised web service | It never holds authority. The broker checks the signature against enrolled public keys itself |
| Prompt injection makes Hermes propose something evil | You read the literal diff or command. The agent's own description is labelled unverified. Hidden characters are shown as `⟦U+202E⟧` and flagged |
| Hermes tries to apply directly | The control socket is owned by the web user, mode 0600. The agent runs as another user and cannot open it |
| Proposal edited after you looked at it | The signature covers a hash of the exact proposal. Any change invalidates it |
| Captured approval replayed | Challenge includes a one-time nonce, consumed on first use, 90 s lifetime |
| Guessing approvals | 6 failures in 10 minutes lock the broker for everyone and each one is journaled and sent to Telegram |
| Patch escapes the project (`../`, symlinks, `.git/hooks`) | Rejected during validation and again before applying |
| Probe used to read secrets | Filter on commands and paths, symlinks resolved before the check, output scrubbed, recursive grep not offered |
| Tampering with the record afterwards | Hash-chained journal; `noxctl doctor` verifies it; every event also goes to Telegram, which the host cannot rewrite |
| Dashboard turns the feature on | The `ENABLED` flag lives in a root-owned directory; only `noxctl changes enable` creates it |

**Not covered, so know it:**

* The last line of defence is you. A passkey tap does not show the command on
  the authenticator. The dashboard shows it, so an XSS in the dashboard could
  show you one thing and ask you to sign another. CSP forbids inline scripts and
  all dynamic text is escaped, but treat the dashboard origin as sensitive.
* Anything you approve runs as root with the powers of root.
* Probe output goes to the AI provider you configured. Do not point Forge at a
  provider you would not give `docker logs` to.
* Someone who already has root on the host can edit the journal tail. The
  Telegram copy is the independent record.

## Enabling

On the hub (or a standalone host):

```bash
noxctl converge            # installs the broker unit and the agent helpers
noxctl changes enable      # needs at least one enrolled passkey
noxctl changes status      # broker, journal chain, last events
```

`noxctl changes disable` switches it off again immediately.

## Fleet nodes

The agent runs on the hub only (nodes are small). It reaches a node through a
signed channel, and **the node verifies your passkey itself**: a compromised hub
cannot make a node run anything without your authenticator.

On the hub, export the keys that may approve:

```bash
noxctl changes export-approvers > approvers.json
```

On each node (root over SSH):

```bash
noxctl changes import-approvers < approvers.json   # trust the hub operator's passkeys
noxctl changes allow-hub <address the node sees the hub connect from>
noxctl changes enable
```

Without `allow-hub` a node refuses all control traffic. Probes and proposals for
a node use `--node ID`; the dashboard shows which server a card targets and the
history merges every reachable node.

Nodes keep their own journal and send their own Telegram messages.

## Files

| Path | Purpose |
|---|---|
| `src/changes/policy.js` | proposal validation, tiers, probe filter, redaction |
| `src/changes/executor.js` | apply, health check, rollback, snapshots |
| `src/changes/approval.js` | passkey challenge and verification |
| `src/changes/journal.js` | hash-chained journal |
| `src/changes/broker.js`, `bin/change-broker.js` | the root service and its two sockets |
| `src/changes/fleet-link.js` | signed hub → node channel |
| `src/routes/api/changes.js`, `public/js/changes.js` | dashboard side |
| `bin/nox-propose.js`, `bin/nox-probe.js` | the agent's tools |
| `/var/lib/vps-sentinel/changes/` | journal, per-change snapshots, `ENABLED`, `approvers.json` |
