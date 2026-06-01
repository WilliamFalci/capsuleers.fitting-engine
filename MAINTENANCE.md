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
2. Run `npm run test:pyfa` **in capsuleers.app** (it imports this package) — the
   631-assertion suite is the release gate. Add a fixture for the new mechanic.
3. `npm run drift:update` to advance the snapshot, then release.

> Because this package is GPL-3.0 (a declared Pyfa derivative), porting Pyfa's
> handler code directly is permitted — a future enhancement could codegen the
> regular `class Effect<N>` → `applyLegacy*` cases. The irregular ones stay
> manual, and parity remains the gate regardless.

## What is NOT automatable

"The package auto-updates fully when Pyfa updates" is **false**. Data: yes.
New hardcoded mechanics: detected automatically, ported by a human, gated by the
parity suite. Never auto-merge engine logic without a green parity run.
