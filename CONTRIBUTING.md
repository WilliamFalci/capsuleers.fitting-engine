# Contributing to eve-fit-engine

Thanks for helping keep the engine at Pyfa parity. This is the **contributor
entry point**: it walks through setup, every internal command, the two
validation suites, how to add/port mechanics, and the project's hard rules.

> Living document — **keep it updated**. If you add/rename an `npm` script,
> change a validation flow, or alter the parity invariants, update this file in
> the same PR. (The rule is also recorded in [`CLAUDE.md`](./CLAUDE.md).)

Related docs (don't duplicate — link):
- [`README.md`](./README.md) — what the package is + public API.
- [`CLAUDE.md`](./CLAUDE.md) — architecture cheat-sheet + the hard invariants.
- [`MAINTENANCE.md`](./MAINTENANCE.md) — the two long-term update streams (SDE, Pyfa).
- [`RELEASE.md`](./RELEASE.md) — publish + how consumers wire to the package.
- [`test/diff/README.md`](./test/diff/README.md) — the differential harness in depth.

---

## 0. TL;DR — the loop

```bash
# one-time
npm install
npm run diff:setup        # builds the headless pyfa oracle under .pyfa/ (~100 MB)

# edit src/ … then ALWAYS, before committing:
npm run build             # dist/ is what the tests run against
npm run typecheck         # must be clean
npm run test:pyfa         # 662/0 — THE release gate, never regress it
npm run diff              # exit 0 — no unexpected diffs vs pyfa
npm run audit:coverage    # "truly silent: 0"
```

Green on all four = your change is shippable.

---

## 1. Prerequisites & setup

- **Node ≥ 18** (CI uses 20; local dev here is on nvm v24). The engine core is
  framework-free, but the tooling (tsup/tsx) needs a modern Node.
- **Python 3** (for the differential oracle — `npm run diff:setup`). A venv with
  minimal `eos` deps is created automatically; you don't need system packages
  beyond `python3` + `venv`.
- **git** with access to clone `pyfa-org/Pyfa` (public).

```bash
git clone git@github.com:WilliamFalci/capsuleers.fitting-engine.git
cd capsuleers.fitting-engine
npm install
```

### Environment gotchas (read these once)

- **`node`/`npm` may not be on PATH** in some shells here — prefix calls with
  `export PATH="$HOME/.nvm/versions/node/<ver>/bin:$PATH"` if `command not found`.
- **`dist/` is gitignored and is what the suites import.** After editing `src/`
  you MUST `npm run build` before `test:pyfa` / `diff` (they run against
  compiled `dist/`, not `src/`). Forgetting this is the #1 "why didn't my fix
  take?" trap.
- **`.pyfa/` (~100 MB) is gitignored**, rebuilt by `npm run diff:setup`. Never
  commit it.
- **`data/` (the SDE bundle, ~8 MB) IS committed** — it's what the fixture suite
  and CI run against. Only `npm run build:data` should change it.

---

## 2. Repository layout

```
src/
  index.ts            # base entry — public surface (no fs/fetch/window)
  node.ts             # ./node entry — loadBundledDataset / computeFromEft / buildAllVSkillProfile
  engine.ts           # computeFit orchestrator (apply order + derive)
  modifierEngine.ts   # SDE modifierInfo dispatcher + ~85 applyLegacy* handlers
                      #   + scaling/stacking decision tables (see §6)
  stackingGroups.ts   # SDE-derived effectID → pyfa penaltyGroup table
  constants.ts        # ATTR ids, OPERATION_BY_SDE_CODE, LEGACY_/OUT_OF_SCOPE_EFFECT_IDS
  fitContext.ts       # domain/target resolution; itemRequiresSkill
  itemState.ts        # per-item modified-attribute container
  modifiedAttribute.ts# affliction list → final value (stacking math)
  derived/            # stat derivations: offense, ehp, tank, capacitor, structure, application
  effects/            # effect-classification helpers (weapon/ewar/…)
  eft/                # EFT parse/format
  profiles.ts, skillCheck.ts, t3cVariant.ts, fitChecks.ts, marketGroupTree.ts, export.ts
test/
  parity/run-pyfa-parity.ts   # 662-assertion fixture suite (+ pyfa/ screenshots)
  diff/                       # differential harness (see §5)
  effect-coverage-audit.ts    # reports SDE effects with no handler
  smoke.mjs, smoke-node.mjs   # quick import/run smoke checks
scripts/
  fetch-sde.mjs, build-bundle.ts        # rebuild data/ from CCP SDE
  setup-pyfa-oracle.sh                  # build the .pyfa oracle
  check-pyfa-drift.mjs + effects-snapshot.json   # detect pyfa effects.py changes
  recalibrate-pyfa-pin.mjs              # bump pyfa pin + regen known-diffs
data/                # committed SDE snapshot bundle (the ./node entry ships this)
.github/workflows/   # ci, sde-refresh, pyfa-drift, diff-parity
```

---

## 3. Command reference (step by step)

Every command is an `npm run <name>`.

| Command | What it does | When you run it |
|---|---|---|
| `build` | `tsup` → `dist/` (ESM+CJS+d.ts, both entries) | after any `src/` change, before tests |
| `typecheck` | `tsc --noEmit` (matches app strictness) | before commit; part of `prepublishOnly` |
| `clean` | `rm -rf dist` | when a stale build misbehaves |
| `test:pyfa` | 662-assertion Pyfa fixture suite vs committed `data/` | **the gate** — must be 662/0 |
| `diff:setup` | clone pyfa + venv + build `eve.db` under `.pyfa/` | once, or after `--rebuild` / pin change |
| `diff` | per-ship differential vs the pyfa oracle | before commit; exit 0 = no unexpected diffs |
| `diff:recalibrate` | regen `known-diffs.mjs` + bump pin (see §7) | ONLY when deliberately bumping pyfa |
| `audit:coverage` | list SDE effects on fittable types with no handler | before commit; want "truly silent: 0" |
| `drift` | diff pyfa `effects.py` vs snapshot + our handler set | weekly CI; run when porting effects |
| `drift:update` | advance the effects snapshot | after you've handled the drift |
| `build:data` | fetch CCP SDE → rebuild `data/` | only when refreshing the bundled SDE |

Smoke checks (not npm scripts): `node test/smoke.mjs` (base entry) and
`node test/smoke-node.mjs` (`./node` entry) — fast sanity that imports resolve
and a trivial fit computes.

### `npm run diff` — flags

```bash
npm run diff                       # all published ships × 4 generated fits
npm run diff -- --ships=587,29990  # only these typeIDs
npm run diff -- --group=Loki       # ships whose group name contains "Loki"
npm run diff -- --limit=20         # first N ships (fast iteration)
npm run diff -- --only=bonused     # one of: bonused | non-bonused | t2 | mixed
npm run diff -- --stats=offense,defense   # restrict compared stat groups
npm run diff -- --tol=0.02         # custom relative tolerance (default 0.01)
npm run diff -- --strict           # treat EVERY diff as a failure (ignore known-diffs)
npm run diff -- --json             # machine-readable output
```

Use `--ships`/`--group`/`--limit` to iterate fast while fixing a specific bug;
run the full `npm run diff` before committing.

---

## 4. Validation suite #1 — `test:pyfa` (the gate)

`test/parity/run-pyfa-parity.ts` computes 23 hand-curated fits at **All-V**
skills with a **Uniform** damage profile and asserts ~662 stats against values
read from real Pyfa screenshots (`test/parity/pyfa/`). **Zero tolerance
overrides** — the numbers match exactly (to display precision).

This is correctness ground truth. **Never weaken it to make another check pass.**

### Adding a fixture (when you implement/port a mechanic)

1. Build the fit in Pyfa (All-V char, Uniform damage profile), screenshot the
   stat panel; drop the image in `test/parity/pyfa/`.
2. Add a `TestFit` entry in `run-pyfa-parity.ts`: ship typeID, modules (typeID +
   slot + state + optional charge), drones/subsystems/mode, and an `expected`
   block keyed by the assertion labels (`Total EHP`, `Weapon DPS`, `Cap to empty
   (s)`, etc.). Omit a key to skip that assertion.
3. `npm run build && npm run test:pyfa` → green.

---

## 5. Validation suite #2 — `npm run diff` (the wide net)

The fixture suite is deep but narrow (23 fits). The differential harness is
broad: it **generates 4 fits for every published ship** and diffs every stat
against a **headless pyfa-org/Pyfa** oracle.

- `oracle/pyfa_oracle.py` runs pyfa's `eos` (wx-free) over a batch of fit-specs
  → normalized stats. Built once by `npm run diff:setup` (clone + venv + eve.db).
- `test/diff/fit-generator.mjs` deterministically builds the 4 fits per ship
  (bonused / non-bonused / t2 / mixed), seeded by shipTypeID.
- `test/diff/stat-schema.mjs` maps our `derived` block ↔ pyfa accessors + the
  comparison tolerance.
- `test/diff/run-diff.mjs` orchestrates, diffs, partitions, reports, sets exit.

**Exit 0 iff there are no _unexpected_ diffs.** A documented set of pyfa
float / modelling / per-ship quirks lives in
[`test/diff/known-diffs.mjs`](test/diff/known-diffs.mjs) and is reported as
ACCEPTED; anything else is UNEXPECTED and fails. See
[`test/diff/README.md`](test/diff/README.md) for the full mechanism.

> **The harness compares our `data/` SDE against pyfa's OWN bundled SDE.** If the
> two drift (CCP/pyfa update at different cadence), you may see diffs that aren't
> engine bugs. That's why pyfa is pinned (§7) and the harness is a scheduled,
> non-blocking CI job (`diff-parity.yml`), not a per-push gate.

---

## 6. Engine architecture you'll touch most

### Apply order (`engine.ts`)
skills → modules → **charges (before their parent module — scripts/crystals must
land first)** → drones → fighters → implants → boosters → mode → `applyLegacy*`
handlers → derive stats. Changing this order is high-risk; run both suites.

### Modifier scaling/stacking (`modifierEngine.ts`)
- `SHIP_BONUS_SCALING_SKILL` — `attr → racial/role skill`. Per-level hull bonuses
  scale by that skill at the ship-side reader. (Largely SDE-derived: attrs that
  a skill effect multiplies by `skillLevel` AND a ship effect reads.)
- `SHIP_ROLE_BONUS_ATTRS` — full-value **FLAT** role/AT/industrial/rookie bonuses
  (the LRSM/ORSM `skillTypeID` is a *recipient selector*, not a per-level
  scaler). All ship-source LRSM/ORSM bonuses reaching the generic path are FLAT;
  genuine per-level ones are caught first by `SHIP_BONUS_SCALING_SKILL`.
- `SEC_STATUS_SCALED_EFFECT_IDS` — AT-frigate effects pyfa scales by pilot
  security status; default pilot sec = 0 → skip (apply 0).
- `computeStackingGroup` + `stackingGroups.ts` — stacking-penalty grouping.
  Default is per-attribute (`attr:<id>`); pyfa's custom penaltyGroups are honored
  conservatively (currently only the cloak's scanResolution group). **Do not
  broaden the honored groups without proving `test:pyfa` stays 662/0** — the
  operation-named groups (postMul/postDiv/preMul) regress the suite.

### Capacitor sim (`derived/capacitor.ts`)
A faithful port of `eos/capSim.py`. Load-bearing details (don't "simplify"):
- **Integer cycle times** — fractional cycles make the period LCM blow up so the
  stable-period early-exit never fires (skews stable %).
- **Turrets `disableStagger`** (fire as a volley `capNeed×N`); others stagger.
- **Cap-booster `clipSize = 0`** = no reload (effectively infinite injector).
- `moduleReactivationDelay` is part of the drain cycle.

### Legacy handlers
Effects with empty `modifierInfo` get hand-written `applyLegacy*` handlers,
registered so the generic dispatcher skips them (`LEGACY_HANDLED_EFFECT_IDS`).
`OUT_OF_SCOPE_EFFECT_IDS` documents effects deliberately not implemented (no
headline-stat impact) so `audit:coverage` stays honest.

---

## 7. Bumping the pinned pyfa version (special workflow)

`PYFA_REF` in `.github/workflows/diff-parity.yml` and `known-diffs.mjs` are
calibrated against **one** pyfa commit. **Move them together, never by hand:**

```bash
rm -rf .pyfa
PYFA_REF=<new-pyfa-commit> npm run diff:setup   # rebuild oracle at the new pin
npm run diff:recalibrate                         # regen known-diffs.mjs + bump PYFA_REF
#   → it carries forward kept reasons, drops resolved entries, and marks
#     genuinely-new diffs "PENDING REVIEW" (exits 1 until you classify them).
#   For each PENDING entry: real bug → FIX the engine (don't accept it);
#                           pyfa quirk → replace the reason with the root cause.
npm run test:pyfa     # must stay 662/0
npm run diff          # must exit 0
```

---

## 8. Porting / changing a Pyfa effect

1. `npm run drift` (or read `pyfa-drift.yml` issue) → which effect IDs changed.
2. Decide: **data-driven** (`modifierInfo` present → works automatically, no code)
   or **hardcoded** (empty `modifierInfo` → needs an `applyLegacy*` handler).
3. For hardcoded: mirror pyfa's `class Effect<N>(BaseEffect)` handler (porting
   pyfa code is allowed — this package is GPL like pyfa). Register the ID.
4. Add a fixture (§4) covering the mechanic.
5. `npm run build && npm run test:pyfa && npm run diff && npm run audit:coverage`.
6. `npm run drift:update` to advance the snapshot.

---

## 9. Best practices & hard rules

- **Never regress `test:pyfa` (662/0).** It is the shipped-engine ground truth.
  No other check (diff harness included) justifies breaking it.
- **`npm run build` before testing.** Suites run against `dist/`.
- **Run BOTH suites before committing.** `test:pyfa` green AND `npm run diff`
  exit 0 (no unexpected). Plus `audit:coverage` = truly silent 0.
- **`known-diffs.mjs` only holds proven non-bugs.** Each entry needs a real
  root-cause reason. If you fix the engine such that an accepted diff disappears,
  delete its entry in the same commit. Never add an entry to silence a real bug.
- **Match pyfa, cite pyfa.** When mirroring `eos` behavior, reference the pyfa
  source (effect class / `fit.py` / `capSim.py`) in a comment.
- **Keep the base entry framework-free.** No `fs`/`fetch`/`window` in `src/`
  outside `node.ts`.
- **`data/` changes only via `build:data`.** Don't hand-edit the bundle.
- **Commit style:** Conventional Commits — `fix(capacitor): …`,
  `fix(modifiers): …`, `test(diff): …`, `docs: …`, `ci: …`, `tooling: …`.
  State the parity result in the body (e.g. `test:pyfa 662/0`).

---

## 10. CI workflows (`.github/workflows/`)

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | every push to main/master + PR | typecheck + build + `test:pyfa` + `audit:coverage` (no publish) |
| `sde-refresh.yml` | daily + manual | rebuild `data/` from CCP; if changed + parity green → bump patch + **publish to npm** |
| `pyfa-drift.yml` | weekly + manual | detect changed pyfa effect IDs → open an issue |
| `diff-parity.yml` | weekly + manual | run `npm run diff` vs the **pinned** pyfa → open an issue on unexpected diffs (non-blocking) |

A normal push **does not publish** — only `sde-refresh` publishes, and only when
the SDE bundle actually changes. To release engine fixes immediately, publish
manually (see [`RELEASE.md`](./RELEASE.md)) and bump the dependency in the
consumers (capsuleers.app, Capsuleers.IA).

---

## 11. Licence

GPL-3.0-or-later — a declared derivative of pyfa-org/Pyfa. By contributing you
agree your contribution is licensed under the same terms. The bundled SDE in
`data/` is CCP's, by mere aggregation (not under this package's GPL).
