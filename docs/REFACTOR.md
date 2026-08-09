# Architecture map

Grouvi Nox is split by responsibility and keeps browser access read-only except authenticated incident and notification controls.

## Browser
- `public/app.js`: composition, live snapshot rendering and event wiring.
- `public/js/`: charts, formatting, panes, incidents, filesystem, notifications and Forge controllers.
- `public/css/`: ordered foundation, workspace, data, operations, Forge, responsive enhancements and notification layers.

## Server
- `src/app.js`: testable Express composition.
- `src/routes/api/`: domain routers with shared rate limits.
- `src/db/`: connection, numbered migrations and domain repositories.
- `src/metrics/services/`: Docker, privileged snapshots and host collectors.
- `bin/docker-read-broker.js`: strict read-only allowlist between the root sidecar and unprivileged web service. The web user must never belong to the Docker group.

## Quality gates
- Unit and HTTP integration tests.
- Mocked Telegram retry tests, no real messages.
- Coverage floor: 50% lines and 40% functions.
- Chromium layout contract for desktop and maximum split-view.
- Secret scan, npm audit, ShellCheck, syntax checks and reproducible release verification.
- Pre-refactor PNG references remain in `tests/visual/baseline.tar.gz`.
