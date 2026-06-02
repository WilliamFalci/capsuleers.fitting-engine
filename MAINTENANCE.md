# Maintaining parity with EVE + Pyfa

There are **two independent update streams**. Keeping them separate is the
whole point of the package boundary.

## 1. EVE SDE changes (CCP balance patches) — fully automatable, no package release

New ships/modules/skills and tweaked attributes ship as data. This package
contains **no data**: the consumer (capsuleers.app) rebuilds its SDE bundle and
injects it. Effects that use data-driven `modifierInfo` work automatically — no
code change here.

Flow (lives in capsuleers.app, not this repo):
1. New SDE released → regenerate the `.jsonl` source.
2. `npm run fitting:bundle` (idempotent, content-hashed) → new bundle version.
3. App redeploys with the new bundle. **This package is untouched.**

→ Can be a scheduled CI job. A balance patch never requires a package release.

## 2. Pyfa hardcoded-effect changes — semi-automated (detect auto, port manual)

Some effects have empty `modifierInfo`; their semantics live in hand-written
Python in [`pyfa-org/Pyfa` `eos/effects.py`](https://github.com/pyfa-org/Pyfa/blob/master/eos/effects.py)
as `class Effect<N>(BaseEffect)`. We mirror those as `applyLegacy*` handlers,
registered in `LEGACY_EFFECT_IDS`.

When Pyfa adds/changes one of these, it is **code, in another language** — there
is no reliable auto-transpile. The pipeline is detect-automatically, port-manually:

```bash
npm run build          # LEGACY_EFFECT_IDS is read from dist
npm run drift          # diff Pyfa effects.py vs snapshot + our hardcoded set
```

`npm run drift` reports effect IDs Pyfa **added / removed / renamed** since the
last snapshot, flagging which intersect our hardcoded handlers. Exit code 2 =
drift. The GitHub Action [`pyfa-drift.yml`](.github/workflows/pyfa-drift.yml)
runs it weekly and opens an issue with the report.

On drift:
1. For each added/changed effect, decide: data-driven (no action) or needs an
   `applyLegacy*` handler (port it — allowed, this package is GPL like Pyfa).
2. Run `npm run test:pyfa` — the 662-assertion fixture suite is the release
   gate. Add a fixture for the new mechanic.
3. Run `npm run diff` (per-ship differential harness, see §3) to catch
   regressions the curated fixtures don't cover.
4. `npm run drift:update` to advance the snapshot, then release.

> Because this package is GPL-3.0 (a declared Pyfa derivative), porting Pyfa's
> handler code directly is permitted — a future enhancement could codegen the
> regular `class Effect<N>` → `applyLegacy*` cases. The irregular ones stay
> manual, and parity remains the gate regardless.

## 3. Differential parity harness (`npm run diff`) — broad regression net

The 662-assertion fixture suite is hand-curated and deep but narrow (23 fits).
The differential harness is the wide net: it generates 4 fits for **every**
published ship and diffs every stat against a headless **pyfa-org/Pyfa** oracle.

```bash
npm run diff:setup       # one-time: clone pyfa-org/Pyfa into .pyfa, venv, eve.db
npm run diff             # all ships × 4 fits → exit 0 iff no UNEXPECTED diffs
npm run diff -- --group=Loki        # scope to a ship group
npm run diff -- --ships=587,29990   # scope to typeIDs
npm run diff -- --strict            # treat EVERY diff as a failure (re-audit)
```

Layout: `test/diff/` — `run-diff.mjs` (orchestrator), `fit-generator.mjs`
(deterministic 4-fits/ship), `stat-schema.mjs` (shared stat map + tolerance),
`known-diffs.mjs` (accepted-differences registry), and `oracle/pyfa_oracle.py`
(the headless pyfa batch driver). `.pyfa/` is gitignored, rebuilt by `diff:setup`.

**Known-differences registry — the honest escape hatch.** A reference impl
(pyfa) carries float / modelling / per-ship quirks an independent engine can't
match without regressing the fixture suite or replicating a pyfa anomaly. Those
residuals live in `test/diff/known-diffs.mjs`, each keyed by
`(ship, fitType, statKey)` and annotated with its ROOT CAUSE. They are reported
as ACCEPTED; anything NOT listed is UNEXPECTED and fails the run — so the harness
still catches every new/real divergence, including a regression that changes an
accepted value. Re-audit the set any time with `--strict`.

> **Hard invariant: never trade away `test:pyfa` 662/0 to make `npm run diff`
> pass.** The current accepted entries (multi-module signatureRadius stacking,
> Griffin Navy drone-control anomaly, Ancillary Shield Booster cap duty cycle,
> sub-3.5 % FP precision) persist *because* their only "fixes" regress the
> fixture suite. If you ever add a known-diff entry, prove first that fixing it
> properly would break `test:pyfa`, and document why in the entry's comment.

When adding/changing engine logic: run BOTH suites. A green `test:pyfa` plus a
green `npm run diff` (no unexpected diffs) is the bar. If a fix legitimately
resolves an accepted diff, delete its registry entry in the same commit.

## What is NOT automatable

"The package auto-updates fully when Pyfa updates" is **false**. Data: yes.
New hardcoded mechanics: detected automatically, ported by a human, gated by the
parity suite **and** the differential harness. Never auto-merge engine logic
without a green parity run + a clean `npm run diff`.
