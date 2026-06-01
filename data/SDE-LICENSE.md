# Bundled EVE Online Static Data Export (SDE)

The JSON files in this directory are derived from CCP's EVE Online Static Data
Export. **They are NOT covered by this package's GPL-3.0 licence.**

EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights
reserved worldwide. All EVE-related materials are the property of CCP hf. This
data is redistributed under CCP's **EVE Online Developer License Agreement**,
which permits use of EVE Online data in third-party tools.

It is included here purely by **mere aggregation** with the engine code (a
convenience so the package works out of the box); it does not form part of, and
is not relicensed by, the GPL-covered program.

To run the engine against a fresher or custom SDE, build your own
`FittingDataset` and use `computeFit` from the base entry instead of the bundled
`@capsuleers/eve-fit-engine/node` loader.
