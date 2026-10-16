# Engine — eve-fit-engine

Leggi se tocchi `src/` (orchestratore, modificatori, stacking, stat derivate) o gli entry point del pacchetto.
Versione corrente: `package.json`. Percorsi relativi alla root del repo.

## Cosa è
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
