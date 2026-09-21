# Bundled EVE Online Static Data Export (SDE)

The JSON files in this directory are derived from CCP's EVE Online Static Data
Export. **They are NOT covered by this package's GPL-3.0 licence.**

EVE Online and the EVE logo are the registered trademarks of Fenris Creations.
All rights are reserved worldwide. All EVE-related materials are the
intellectual property of Fenris Creations, which does not endorse, and is in no
way affiliated with, this package. This data is redistributed under the **EVE
Online Developer License Agreement**, which permits use of EVE Online data in
third-party tools.

It is included here purely by **mere aggregation** with the engine code (a
convenience so the package works out of the box); it does not form part of, and
is not relicensed by, the GPL-covered program.

To run the engine against a fresher or custom SDE, build your own
`FittingDataset` and use `computeFit` from the base entry instead of the bundled
`eve-fit-engine/node` loader.
