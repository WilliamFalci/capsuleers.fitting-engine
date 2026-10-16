# Rilascio e manutenzione

Leggi se pubblichi, tocchi la CI di rilascio o il refresh SDE. Flussi completi: `MAINTENANCE.md`, `RELEASE.md`.

See `MAINTENANCE.md` (the two update streams) and `RELEASE.md` (publish + how the
app wires to the package). SDE balance patches are data-only (no package
release); new Pyfa hardcoded mechanics are detected by `npm run drift` and ported
manually, then gated by both suites.

Two CI publish paths (both gate on `npm run test:pyfa` + `npm run audit:coverage`
and publish with the `prod`-environment `NPM_TOKEN`):
- **`.github/workflows/sde-refresh.yml`** — daily cron; rebuilds `data/` from
  CCP's latest SDE and, *only if the bundle changed and parity stays green*,
  commits the new `data/` + bumps a patch + auto-publishes (these are the
  `[auto]` release commits). On parity failure it opens an issue and does NOT
  publish.
  **It runs at 05:00 UTC, so a CCP release in the evening stays uncovered for
  up to ~10 h** — 3538132 landed 2026-09-22 19:31Z, after that day's run had
  already shipped 3528119. When a new SDE is announced, dispatch it by hand:
  `gh workflow run sde-refresh.yml` (v0.2.3 was published this way, gate green).
- **`.github/workflows/release.yml`** — manual `workflow_dispatch` with a
  `bump` choice (`patch`/`minor`/`major`). This is the path for **code-only
  fixes** (engine changes don't touch `data/`, so they never trigger
  `sde-refresh`); run it by hand to `npm version` → publish → push tag.
