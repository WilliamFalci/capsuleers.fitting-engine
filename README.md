# eve-fit-engine

A **Pyfa-parity** EVE Online ship & Upwell-structure fitting calculation engine,
extracted from [capsuleers.app](https://capsuleers.app). Given a fit and an SDE
dataset, it returns the full derived stat block you'd see in a fitting tool:
offense (DPS / alpha / application), defense (EHP / resists / tank), capacitor
(stability / sim), navigation, targeting, fitting (CPU / PG / calibration),
projected effects, and structure fuel/service stats.

> **Licence: GPL-3.0-or-later.** This engine is a derivative work of
> [pyfa-org/Pyfa](https://github.com/pyfa-org/Pyfa) and is distributed under the
> same terms. See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE). The complete
> corresponding source is this repository.

## Design

- **Framework-free core.** The base entry has no `fetch`, no `fs`, no `window`,
  no npm runtime deps. Runs in the browser, in Node, in a worker — anywhere.
- **Two entries.** Base (`.`): inject your own `FittingDataset`. Node (`./node`):
  batteries-included — bundles a snapshot of the EVE SDE (under CCP's licence, by
  mere aggregation) + an fs loader, so it works out of the box on the server.
- **Validated against Pyfa two ways.**
  - **Fixture suite** — `npm run test:pyfa`: 662 hand-curated assertions against
    Pyfa screenshots, All-V skills, zero tolerance overrides. This is the
    release gate and the engine's correctness ground truth.
  - **Differential harness** — `npm run diff`: generates 4 fits for *every*
    published ship and compares every stat against a headless **pyfa-org/Pyfa**
    oracle. 1646/1676 fits (98.2%) match exactly; the residual is a documented
    set of pyfa float/modelling/per-ship quirks (see
    [`test/diff/known-diffs.mjs`](test/diff/known-diffs.mjs)). Exits 0 on no
    *unexpected* diffs; `--strict` re-lists the accepted set as failures.

## Install

```bash
npm install eve-fit-engine
```

## Usage — zero-config (Node, batteries-included)

The `/node` entry ships with the EVE SDE bundle (`data/`, ~8 MB) and a built-in
loader. Give it an EFT string, get full stats — nothing else to set up:

```ts
import { computeFromEft } from 'eve-fit-engine/node'

const { fit, warnings, computed } = await computeFromEft(`
[Rifter, My Fit]
200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S
1MN Afterburner II
Gyrostabilizer II
`)

console.log(computed.derived.offense.totalDps)              // 197.6
console.log(computed.derived.defense.ehpTotalAgainstProfile)
console.log(computed.derived.navigation.maxVelocity)
```

Defaults to All-V skills; pass `{ skillProfile, damageProfile, targetProfile, … }`
as the second arg to override. `loadBundledDataset()` is also exported if you
want the dataset directly.

> The bundled SDE is CCP's, under CCP's EVE Online Developer License (see
> [`data/SDE-LICENSE.md`](./data/SDE-LICENSE.md)) — included by mere aggregation,
> NOT under this package's GPL.

## Usage — bring-your-own dataset (browser / custom / always-fresh SDE)

The base entry is environment-free (no `fs`, no bundled data). Inject a
`FittingDataset` you build however you like:

```ts
import { computeFit, parseEft, type FittingDataset } from 'eve-fit-engine'

const dataset: FittingDataset = await buildYourDataset()   // your SDE bundle
const { fit } = parseEft(eftText, dataset)
const computed = computeFit(fit, dataset, { skillProfile /* … */ })
```

This is what capsuleers.app uses server-side: it builds its own always-fresh
bundle and injects it, so it never depends on the (snapshot) bundled data.

## What's NOT in this package

- 3D ship models, UI components — those live in the consuming application.
- The bundled SDE is a **snapshot**; for always-fresh data, inject your own via
  the base entry (see above).

## Provenance / how parity is maintained

The engine mirrors Pyfa's `eos` calculation model: effect handlers keyed by EVE
dogma effect IDs, stacking-penalty pools, a late-runtime resistance-adaptation
pass, a discrete capacitor simulation (faithful port of `eos/capSim.py` —
integer cycle times, turret-volley vs staggered drains, cap-booster injection),
and spool-up handling. When CCP ships a new SDE, data-driven `modifierInfo`
effects work automatically; new hardcoded mechanics in Pyfa's `effects.py` are
tracked and ported, then re-checked against **both** the fixture suite
(`npm run test:pyfa`) and the per-ship differential harness (`npm run diff`)
before release. See [`MAINTENANCE.md`](./MAINTENANCE.md) for the update flows.

## Licence

GPL-3.0-or-later. Copyright (C) 2026 Capsuleers.app. This is free software; see
[`LICENSE`](./LICENSE) for details.
