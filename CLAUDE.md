# CLAUDE.md

Guidance for Claude Code when working in **eve-fit-engine**.

## What this is

A **Pyfa-parity** EVE Online ship & Upwell-structure fitting calculation engine,
extracted from capsuleers.app and published to npm as `eve-fit-engine`. Inject a
`FittingDataset` + a `Fit`, get the full derived stat block (offense, defense,
capacitor, navigation, targeting, fitting, projected, structure).

- **Licence: GPL-3.0-or-later.** It is a declared derivative of
  [pyfa-org/Pyfa](https://github.com/pyfa-org/Pyfa) (`eos`). Porting Pyfa handler
  code directly is permitted. capsuleers.app consumes it **server-side only** so
  the app's closed source isn't forced GPL (GPL triggers on client distribution,
  not server-side network use).
- **Two entry points** (`package.json#exports`):
  - `.` (base) — framework-free: no `fs`/`fetch`/`window`, no runtime deps. You
    inject the dataset. This is what capsuleers.app uses (always-fresh SDE).
  - `./node` — batteries-included: bundles an SDE snapshot in `data/` +
    `loadBundledDataset()`, `computeFromEft()`, `buildAllVSkillProfile()`.

## Environment gotchas

- **`node`/`npm` aren't on the default PATH here.** Prefix every shell call:
  `export PATH="/home/TremalJack/.nvm/versions/node/v24.13.0/bin:$PATH"`.
- A Claude Code hook blocks `node scripts/...` (a Prisma rule from the parent
  workspace). Use `npm run <script>` or absolute paths; don't invoke raw `node`
  on repo scripts.
- `dist/` is gitignored and built by `tsup`. After editing `src/`, run
  `npm run build` before anything that imports `dist/` (the diff harness and the
  parity suite both run against `dist/`).

## Commands

```bash
npm run build         # tsup → dist/ (ESM + CJS + d.ts), both entries
npm run typecheck     # tsc --noEmit (matches app strictness; no noUncheckedIndexedAccess)
npm run test:pyfa     # 662-assertion Pyfa fixture suite — THE release gate
npm run diff          # per-ship differential harness vs headless pyfa (see below)
npm run audit:coverage# report SDE effects on fittable types with no handler ("truly silent: 0")
npm run drift         # diff pyfa effects.py vs snapshot + our hardcoded handler set
npm run build:data    # fetch CCP SDE → rebuild data/ bundle (consumer-style)
```

## Source architecture (`src/`)

- `engine.ts` — `computeFit` orchestrator: applies skills → modules → charges
  (BEFORE their parent module, so scripts/crystals land first) → drones →
  fighters → implants → boosters → mode → legacy handlers → derive stats.
- `modifierEngine.ts` — the dispatcher. `applySourceItem` + `applyOneModifier`
  for SDE `modifierInfo`, ~85 `applyLegacy*` hardcoded handlers, plus the
  scaling/stacking decision tables:
  - `SHIP_BONUS_SCALING_SKILL` (attr → racial/role skill; per-level hull bonuses
    scale by that skill at the ship-side reader).
  - `SHIP_ROLE_BONUS_ATTRS` (full-value FLAT role/AT/industrial/rookie bonuses —
    NOT per-level; the LRSM/ORSM skill is just a recipient selector). NB: all
    ship-source LRSM/ORSM bonuses reaching the generic path are treated FLAT;
    racial per-level ones are caught first by SHIP_BONUS_SCALING_SKILL.
  - `SEC_STATUS_SCALED_EFFECT_IDS` (AT-frigate effects pyfa scales by pilot
    security status; default pilot sec = 0 → skip, apply 0).
  - `computeStackingGroup` — stacking-penalty grouping (currently per-attribute
    `attr:<id>` + the cloak's own scanResolution group; see `stackingGroups.ts`).
- `stackingGroups.ts` — `STACKING_PENALTY_GROUPS`: SDE-derived effectID → pyfa
  penaltyGroup. Honored conservatively (cloak group only); fully honoring the
  operation-named groups regresses the fixture suite — do NOT enable without
  proving `test:pyfa` stays 662/0.
- `derived/` — stat derivations: `offense.ts`, `ehp.ts`, `tank.ts`,
  `capacitor.ts`, `structure.ts`, `application.ts`. The capacitor sim is a
  faithful port of `eos/capSim.py` (integer cycle times → sane LCM/early-exit;
  turret drains volley `capNeed×N` while others stagger; cap-booster `clipSize=0`
  = infinite injector; `moduleReactivationDelay` in the drain cycle).
- `constants.ts` (`ATTR`, `OPERATION_BY_SDE_CODE`, `LEGACY_EFFECT_IDS`,
  `OUT_OF_SCOPE_EFFECT_IDS`), `fitContext.ts`, `itemState.ts`,
  `modifiedAttribute.ts`, `profiles.ts` (damage/target presets, All-V),
  `t3cVariant.ts`, `fitChecks.ts`, `eft/` (EFT parse/format), `effects/`.

## Validation — two suites, one invariant

1. **`npm run test:pyfa`** (`test/parity/run-pyfa-parity.ts`) — 662 assertions
   across 23 hand-curated fits vs Pyfa screenshots, All-V, zero tolerance
   overrides. **This is correctness ground truth and the release gate.**
2. **`npm run diff`** (`test/diff/`) — generates 4 fits for every published ship
   and diffs every stat against a headless **pyfa-org/Pyfa** oracle
   (`oracle/pyfa_oracle.py` via `.pyfa/`, built by `npm run diff:setup`). Exits 0
   iff there are no **unexpected** diffs. A documented set of pyfa
   float/modelling/per-ship quirks lives in `test/diff/known-diffs.mjs` (keyed by
   `(ship, fitType, statKey)`, each with its ROOT CAUSE) and is reported as
   ACCEPTED. `--strict` treats every diff as a failure (use to re-audit).

> **HARD INVARIANT: never regress `test:pyfa` 662/0 to make `npm run diff` pass,
> and never silently widen the known-diffs list.** The accepted diffs persist
> only because their proper fixes regress the fixture suite. When changing engine
> logic, run BOTH suites; if a fix legitimately resolves an accepted diff, delete
> its `known-diffs.mjs` entry in the same commit. New/real divergences MUST fail
> the harness.

### RULE — bumping the pyfa pin (always do this together)

The diff oracle is pinned: `PYFA_REF` in `.github/workflows/diff-parity.yml` and
`known-diffs.mjs` are calibrated against ONE pyfa commit. **Whenever you bump
pyfa deliberately, recalibrate both in the same change** — never move the pin
without re-running the registry, and never edit the registry by hand for a pin
change:

```bash
rm -rf .pyfa
PYFA_REF=<new-pyfa-commit> npm run diff:setup    # rebuild oracle at the new pin
npm run diff:recalibrate                          # regen known-diffs.mjs + bump PYFA_REF
# → classify every entry it marks "PENDING REVIEW":
#     real bug  → FIX the engine, re-run (don't accept it);
#     pyfa quirk → replace the reason with the real root cause.
npm run test:pyfa     # must stay 662/0
npm run diff          # must exit 0
```

`npm run diff:recalibrate` ([scripts/recalibrate-pyfa-pin.mjs](scripts/recalibrate-pyfa-pin.mjs))
does the mechanical half: reads the current `.pyfa` HEAD as the new pin, runs the
diff in `--strict` mode, carries forward reasons for kept entries, drops resolved
ones, marks genuinely-new diffs `PENDING REVIEW`, rewrites `known-diffs.mjs`, and
bumps `PYFA_REF`. It exits 1 while any entry is `PENDING REVIEW`. The human still
classifies the new diffs — auto-accepting them all would mask real regressions.

## Maintenance flows

See `MAINTENANCE.md` (the two update streams) and `RELEASE.md` (publish + how the
app wires to the package). SDE balance patches are data-only (no package
release); new Pyfa hardcoded mechanics are detected by `npm run drift` and ported
manually, then gated by both suites.
