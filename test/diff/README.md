# Differential Pyfa-parity harness

Automatically finds where `eve-fit-engine` disagrees with **pyfa-org/Pyfa**. For
every ship it generates 4 fits, computes the stats with both engines, and prints
every difference. No screenshots. Designed to drive a `/goal` verify-and-fix loop.

## One-time setup

```bash
npm run diff:setup        # clones pyfa-org/Pyfa into .pyfa, venv, builds eve.db
```

This builds a headless Pyfa oracle (`oracle/pyfa_oracle.py`) under `.pyfa/`
(gitignored, ~100 MB). `eos` runs wx-free; only sqlalchemy/logbook are needed.
Re-run with `npm run diff:setup -- --rebuild` to rebuild `eve.db` after a pyfa update.

## Run

```bash
npm run diff                          # all published ships × 4 fits
npm run diff -- --ships=587,29990     # specific ships (typeIDs)
npm run diff -- --group=Loki          # ship group name contains "Loki"
npm run diff -- --limit=20            # first N ships (fast iteration)
npm run diff -- --only=bonused        # one fit type only
npm run diff -- --stats=offense,defense   # only some stat groups
npm run diff -- --tol=0.02 --json     # custom tolerance / machine output
```

Exit code is **1** when any difference exceeds tolerance (default 1% relative +
0.01 absolute), **0** when everything matches — so a loop can detect "done".

### Known / accepted differences

A small set of residual diffs are **documented pyfa float / modelling / per-ship
quirks** that an independent engine cannot match without regressing the
662-fixture Pyfa-parity suite (`npm run test:pyfa`) or replicating a
pyfa-specific anomaly. They live in [`known-diffs.mjs`](known-diffs.mjs), each
annotated with its ROOT CAUSE, and are reported as **ACCEPTED** (they do not
fail the run). Anything NOT on that list is an **UNEXPECTED** diff and fails the
run — so the harness still catches every new/real divergence, including a
regression that changes one of the accepted values.

- `npm run diff` → exit 0 iff there are no *unexpected* diffs (accepted ones are
  printed for transparency).
- `npm run diff -- --strict` → treat **every** diff as a failure (ignore the
  known-diffs list); use this to re-audit the accepted set.

The hard invariant: the engine NEVER trades away `test:pyfa` 662/0 to satisfy
this harness. The accepted diffs persist precisely because the only "fixes" for
them regress that suite (see `known-diffs.mjs` for the per-entry rationale).

## The 4 fits per ship

- **bonused** — weapons of the ship's primary hardpoint system (T2) + matching mods
- **non-bonused** — a different weapon system / off-bonus modules
- **t2** — every slot filled with T2 modules
- **mixed** — weapons + a spread of T1/T2/faction/deadspace/officer mods

Slot/hardpoint/drone capacities are read from our own engine (so T3Cs with their
4 subsystems work too). Generation is seeded by shipTypeID → reproducible diffs.

## Using with /goal

```
/goal make `npm run diff` pass — fix eve-fit-engine so its stats match pyfa
```

Workflow each iteration:
1. `npm run diff -- --limit=N` (or `--ships=` / `--group=`) to scope.
2. Read the grouped report; a stat that diverges on MANY ships is usually one
   engine bug (a missing/mis-scaled modifier). A one-off is often the fit itself.
3. Fix the handler in `src/`, `npm run build`, re-run the diff + `npm run test:pyfa`
   (must stay green), repeat.

## Components

- `scripts/setup-pyfa-oracle.sh` — builds the `.pyfa` oracle (clone + venv + eve.db).
- `oracle/pyfa_oracle.py` — batch driver: JSON fit-specs (stdin) → normalized stats (stdout).
- `test/diff/stat-schema.mjs` — common stat schema + units + `diffStats` (tolerance).
- `test/diff/fit-generator.mjs` — deterministic 4-fits-per-ship generator.
- `test/diff/run-diff.mjs` — orchestrator + report + exit code.

## Caveats (v1 fit generator)

The generator is best-effort: it can over-stack modules or pick odd combos, so a
*small fraction* of diffs reflect the generated fit rather than an engine bug.
Signal heuristic: **systematic** diffs (same stat, many ships, similar %) are real
engine bugs; isolated extreme values (e.g. a single sentinel) are usually the fit.
Refine `fit-generator.mjs` (module states, drone active counts, weapon sizing) to
reduce noise as needed.
