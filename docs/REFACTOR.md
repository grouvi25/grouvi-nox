# Refactor map

Behavior-preserving modularization of the production dashboard.

- `public/css/`: five ordered visual layers, loaded by `style.css`.
- `public/js/`: pure utilities, canvas charts, Markdown, pane mechanics, notifications.
- `src/routes/api/`: core, incidents, agent, services, notifications, shared limits.
- `tests/unit/refactor.test.js`: characterization tests.
- `tests/visual/baseline.tar.gz`: five pre-refactor PNG references, geometry, hashes.

Production and `main` remain unchanged until review.
