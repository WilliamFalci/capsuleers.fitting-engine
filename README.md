# @capsuleers/eve-fit-engine

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

- **Framework-free.** No `fetch`, no `fs`, no `window`, no npm runtime deps. Runs
  in the browser, in Node, in a worker — anywhere.
- **No game data inside.** The package ships zero EVE SDE data (that is CCP's,
  under CCP's own licence). You inject a `FittingDataset` built however you like.
- **Validated against Pyfa.** Stat parity is verified against Pyfa screenshots in
  the upstream capsuleers.app fixture suite (`npm run test:pyfa`, 631 assertions
  at All-V skills, zero tolerance overrides).

## Install

```bash
npm install @capsuleers/eve-fit-engine
```

## Usage

```ts
import { computeFit, parseEft, type FittingDataset } from '@capsuleers/eve-fit-engine'

// You provide the dataset (SDE attributes/effects/types). See the FittingDataset
// type for the exact shape. capsuleers.app builds it from the EVE SDE; you can
// build it from the SDE, from fuzzwork, or from your own export.
const dataset: FittingDataset = await buildYourDataset()

const fit = parseEft(eftText, dataset)            // EFT string -> Fit
const computed = computeFit(fit, dataset, {
    skillProfile,                                  // e.g. all-level-V
    damageProfile,
    targetProfile,
})

console.log(computed.derived.offense.totalDps)
console.log(computed.derived.defense.ehpTotalAgainstProfile)
```

## What's NOT in this package

- The dataset **loader** (HTTP or fs) — environment-specific, you supply it.
- EVE **SDE data** — CCP's, shipped separately under CCP's terms.
- 3D ship models, UI components — those live in the consuming application.

## Provenance / how parity is maintained

The engine mirrors Pyfa's `eos` calculation model: effect handlers keyed by EVE
dogma effect IDs, separate stacking-penalty pools per operation, a late-runtime
resistance-adaptation pass, capacitor simulation, and spool-up handling. When CCP
ships a new SDE, data-driven `modifierInfo` effects work automatically; new
hardcoded mechanics in Pyfa's `effects.py` are tracked and ported, then re-checked
against the parity suite before release.

## Licence

GPL-3.0-or-later. Copyright (C) 2026 Capsuleers.app. This is free software; see
[`LICENSE`](./LICENSE) for details.
