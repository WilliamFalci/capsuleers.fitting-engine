# CLAUDE.md

Guidance for Claude Code when working in **eve-fit-engine**.

## What this is

A **Pyfa-parity** EVE Online ship & Upwell-structure fitting calculation engine,
extracted from capsuleers.app and published to npm as `eve-fit-engine`. Inject a
`FittingDataset` + a `Fit`, get the full derived stat block (offense, defense,
capacitor, navigation, targeting, fitting, projected, structure).

> **0.1.10** (current published version) — the version stream is mostly
> daily SDE-bundle auto-patches (`sde-refresh.yml`); the latest *code* fix
> (`dfe6427`, owner-skill modifier leak) is described under "Modifier engine"
> below. Both parity suites stay green (`test:pyfa` 662/0, `npm run diff`
> exits 0).

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
npm run diff          # differential harness vs headless pyfa (see below)
npm run corpus:fetch  # harvest 2-3 REAL fits per hull from EVE Workbench (needs EVEWORKBENCH_API_KEY)
npm run stacking:build# regenerate src/stackingPenalised.ts from the pinned pyfa (--check to verify)
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
  - **Owner-skill modifier targeting** (`fitContext.ts`, fixed in `dfe6427`):
    an `OwnerRequiredSkillModifier` (domain `charID`) reaches the character's
    own drones / fighters / loaded charges but must NOT self-target
    ship-domain modules. The combo damage modules that boost both turrets and
    drones require the Drones skill, so a naïve "any module requiring the
    skill" resolver made them self-match their own owner modifier and inflate
    `damageMultiplier` (symptom: phantom +50% turret DPS on Freki/Khizriel/
    etc.). Keep modules out of the owner-skill target set — mirrors pyfa's
    `Effect6556`, which only touches `fit.drones` / `fit.fighters`.
- `stackingPenalised.ts` — **GENERATED** (`npm run stacking:build`, from the
  PINNED pyfa under `.pyfa`): which `(effect, attribute, receiver)` triples pyfa
  stack-penalises, in which `penaltyGroup`, and which source kinds it exempts.
  The penalty is a property of the CALL, not of the attribute: pyfa writes
  `stackingPenalties=True` one boost at a time, and only **403 of its 2 799**
  attribute-boosting calls penalise. This engine used to penalise every modifier
  sharing an attribute, which chained bonuses pyfa keeps independent (a Rokh
  with an MWD *and* an MJD read 6 335 m of signature radius against 6 875).
  Keyed by attribute **ID**, not name — the shipped bundle carries only
  PUBLISHED attributes, and keying on names silently missed
  `warpSpeedMultiplier` (600, unpublished) on 32 real fits. The generator
  cross-checks every key against the SDE and reports pairs where pyfa's handler
  body and the SDE effect have drifted apart (two today, one of which needs the
  `OVERRIDES` row it carries).
- `stackingGroups.ts` — `STACKING_PENALTY_GROUPS`: SDE-derived effectID → pyfa
  penaltyGroup. Superseded for the penalty decision by `stackingPenalised.ts`;
  the honoured-group set lives in `modifierEngine.ts` and honours everything
  EXCEPT `preMul`, which is measured (8 fixture assertions) rather than assumed.
- `derived/` — stat derivations: `offense.ts`, `ehp.ts`, `tank.ts`,
  `capacitor.ts`, `structure.ts`, `application.ts`. The capacitor sim is a
  faithful port of `eos/capSim.py` (integer cycle times → sane LCM/early-exit;
  turret drains volley `capNeed×N` while others stagger; cap-booster `clipSize=0`
  = infinite injector; `moduleReactivationDelay` in the drain cycle;
  per-module drain dedupe — a module pays its activation cap cost ONCE even when
  it carries multiple discharge-bearing effects, mirroring pyfa's per-module
  `capUse`; the lone SDE type that needs this is "Dual Afocal Light Laser I"
  (6633), the only one with two discharge effects 10+263).
- `constants.ts` (`ATTR`, `OPERATION_BY_SDE_CODE`, `LEGACY_EFFECT_IDS`,
  `OUT_OF_SCOPE_EFFECT_IDS`), `fitContext.ts`, `itemState.ts`,
  `modifiedAttribute.ts`, `profiles.ts` (damage/target presets, All-V),
  `t3cVariant.ts`, `fitChecks.ts`, `eft/` (EFT parse/format), `effects/`.

## Validation — two suites, one invariant

1. **`npm run test:pyfa`** (`test/parity/run-pyfa-parity.ts`) — 662 assertions
   across 23 hand-curated fits vs Pyfa screenshots, All-V, zero tolerance
   overrides. **This is correctness ground truth and the release gate.**
2. **`npm run diff`** (`test/diff/`) — diffs every stat against a headless
   **pyfa-org/Pyfa** oracle (`oracle/pyfa_oracle.py` via `.pyfa/`, built by
   `npm run diff:setup`) over THREE corpora, selected with `--source`
   (`generated` by default, or `workbench`, `implants`, `all`):

   | source | what it is | size |
   |---|---|---|
   | `generated` | 4 synthetic fits for every published ship (`fit-generator.mjs`) | 1 692 fits |
   | `workbench` | 2-3 REAL fits per hull, published by capsuleers on EVE Workbench | 913 fits / 330 hulls |
   | `implants` | every implant SET + every ship-affecting booster, drawbacks off AND on | 1 857 fits |

   The generated corpus is built by OUR OWN slot/charge predicates, so on its
   own it only exercises what we already believe fits. The other two exist
   because that blind spot was expensive: the real-fit corpus found **six**
   engine bugs on its first run (T3D modes, Polarized weapons, freighter role
   bonuses, an EFT importer dropping implants, …) and the implant corpus found
   three more that no module-only fit can reach.

   Corpus notes are printed and never swallowed — an unparseable fit or an item
   the pinned pyfa doesn't know is reported, because a shrinking corpus that
   still says "no differences" is the one failure this harness must not produce.

   Exits 0 iff there are no **unexpected** diffs. `test/diff/known-diffs.mjs`
   holds the accepted set (keyed by `(ship, fitType, statKey)`, each with its
   ROOT CAUSE); `--strict` treats every diff as a failure (use to re-audit).
   That list was 19 entries and is now **one** — the other 18 were bugs, not
   quirks. Don't grow it to turn a red run green.

   **The Workbench corpus is a gitignored cache** (`.workbench/`), harvested by
   `npm run corpus:fetch`: those are other capsuleers' published fits, read the
   way the site reads them and not redistributed. Their API rate-limits on
   BURST, so the fetch runs at concurrency 2 and resumes from what it already
   has; don't raise it.

### What "parity" currently measures

| suite | corpus | result |
|---|---|---|
| `test:pyfa` | 23 hand-curated fits vs pyfa screenshots | **662 / 0** |
| `diff --source=generated` | 1 692 synthetic fits, every published hull | **1 691 / 1 692** |
| `diff --source=workbench` | 913 real published fits, 330 hulls | **913 / 913** |
| `diff --source=implants` | 1 857 implant-set / booster fits | **1 857 / 1 857** |

One accepted difference remains, and it is a boundary artefact rather than a
modelling choice: a Griffin Navy Issue held barely cap-stable by an amortised
cap booster settles at ~1.1 % of its capacitor, where the recharge curve is
nearly vertical. We solve that equilibrium analytically and pyfa reports the
minimum its time-stepped simulation reaches; the two agree to four decimals
wherever the curve is flat.

> **HARD INVARIANT: never regress `test:pyfa` 662/0 to make `npm run diff` pass,
> and never silently widen the known-diffs list.** The accepted diffs persist
> only because their proper fixes regress the fixture suite. When changing engine
> logic, run BOTH suites; if a fix legitimately resolves an accepted diff, delete
> its `known-diffs.mjs` entry in the same commit. New/real divergences MUST fail
> the harness.

### RULE — bumping the pyfa pin (always do this together)

The diff oracle is pinned: `PYFA_REF` in `.github/workflows/diff-parity.yml`,
`known-diffs.mjs` and the GENERATED `src/stackingPenalised.ts` are calibrated
against ONE pyfa commit. **Whenever you bump
pyfa deliberately, recalibrate both in the same change** — never move the pin
without re-running the registry, and never edit the registry by hand for a pin
change:

```bash
rm -rf .pyfa
PYFA_REF=<new-pyfa-commit> npm run diff:setup    # rebuild oracle at the new pin
npm run stacking:build                            # regen the stacking registry FROM that pyfa
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

**The pin also advances on its own** — [`pyfa-pin-bump.yml`](.github/workflows/pyfa-pin-bump.yml),
Sundays 12:00 UTC, ahead of Monday's `pyfa-drift` (06:00) + `diff-parity` (07:00).
It moves the pin to pyfa master, recalibrates, and **auto-commits only when the
recalibration has nothing to classify**; the moment a genuinely-new stat diff
appears it opens a PR labelled `diff-parity` instead and fails the run, because a
robot must never write a `known-diffs.mjs` reason. Nothing there is published —
`PYFA_REF` and the registry are harness files, outside package.json `files`.

Why it exists: `data/` refreshed itself daily and the pin did not, so the oracle
fell behind CCP. Issue #34 was that asymmetry — a new module (`Breach Control`)
plus an Aralez rework produced 46 phantom "engine" diffs, and the oracle had been
dropping the unknown types *silently*, so `oracle-fail 0` read as reassurance
while two fits ran a module short. The oracle now declares what it cannot supply
and the runner skips those fits as `oracle-skipped` (see
[test/diff/README.md](test/diff/README.md)).

## Maintenance flows

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
- **`.github/workflows/release.yml`** — manual `workflow_dispatch` with a
  `bump` choice (`patch`/`minor`/`major`). This is the path for **code-only
  fixes** (engine changes don't touch `data/`, so they never trigger
  `sde-refresh`); run it by hand to `npm version` → publish → push tag.

## Docs upkeep (RULE)

[`CONTRIBUTING.md`](./CONTRIBUTING.md) is the contributor entry point (setup,
every command, the validation suites, best practices). **Keep it — and the
command/flow references in this file — in sync whenever you add/rename an `npm`
script, change a validation or release flow, or alter a parity invariant.** Do
it in the same PR as the change; stale command docs are a contributor trap.
