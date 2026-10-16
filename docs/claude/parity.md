# Parità con Pyfa — suite, known-diffs, pin

Leggi se tocchi `test/`, `test/diff/known-diffs.mjs`, l'oracle pyfa, `PYFA_REF`, `src/stackingPenalised.ts` o i workflow di parità. Dettagli harness: `test/diff/README.md`.

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

`npm run diff:recalibrate` ([scripts/recalibrate-pyfa-pin.mjs](../../scripts/recalibrate-pyfa-pin.mjs))
does the mechanical half: reads the current `.pyfa` HEAD as the new pin, runs the
diff in `--strict` mode, carries forward reasons for kept entries, drops resolved
ones, marks genuinely-new diffs `PENDING REVIEW`, rewrites `known-diffs.mjs`, and
bumps `PYFA_REF`. It exits 1 while any entry is `PENDING REVIEW`. The human still
classifies the new diffs — auto-accepting them all would mask real regressions.

**The pin also advances on its own** — [`pyfa-pin-bump.yml`](../../.github/workflows/pyfa-pin-bump.yml),
Sundays 12:00 UTC, ahead of Monday's `pyfa-drift` (06:00) + `diff-parity` (07:00).
It moves the pin to pyfa master, recalibrates, and **auto-commits only when the
recalibration has nothing to classify**; the moment a genuinely-new stat diff
appears it opens a PR labelled `diff-parity` instead and fails the run, because a
robot must never write a `known-diffs.mjs` reason. Nothing there is published —
`PYFA_REF` and the registry are harness files, outside package.json `files`.

**The oracle's SQLAlchemy version is read from the pin's `pyproject.toml`**
(`scripts/setup-pyfa-oracle.sh`), never hardcoded. pyfa moved to SQLAlchemy 2.x
in September 2026; the script still forced 1.4.50, so `db_update.py` died on
`attribute_keyed_dict`, the 2026-09-27 bump went red, and the pin froze at
`8b04f3b` for three weeks. Meanwhile CCP shipped the hybrid-drone rework and
other balance changes: issues #37-#48 reported ~500 "engine" diffs (drone DPS
+15 %, Black Ops mass −25 %, …) that were ALL oracle staleness — against pyfa
`3b9ce39` the same corpora read 4505/4506 with zero unexpected diffs. A red
`pyfa-pin-bump` is therefore not a harmless skip: it is the start of a false
alarm cascade. Read its log before the Monday issues.

Why it exists: `data/` refreshed itself daily and the pin did not, so the oracle
fell behind CCP. Issue #34 was that asymmetry — a new module (`Breach Control`)
plus an Aralez rework produced 46 phantom "engine" diffs, and the oracle had been
dropping the unknown types *silently*, so `oracle-fail 0` read as reassurance
while two fits ran a module short. The oracle now declares what it cannot supply
and the runner skips those fits as `oracle-skipped` (see
[test/diff/README.md](../../test/diff/README.md)).
