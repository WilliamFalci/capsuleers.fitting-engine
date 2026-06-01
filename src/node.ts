/**
 * Batteries-included Node entry: `@capsuleers/eve-fit-engine/node`.
 *
 * The base entry (`@capsuleers/eve-fit-engine`) is environment-free and needs a
 * `FittingDataset` injected. THIS entry ships with the EVE SDE bundle (under
 * `data/`, ~8 MB) and a Node fs loader, so a consumer can go from an EFT string
 * to full stats with zero setup:
 *
 *   import { computeFromEft } from '@capsuleers/eve-fit-engine/node'
 *   const { computed } = await computeFromEft(eftString)
 *   computed.derived.offense.totalDps // ...
 *
 * The bundled SDE is CCP's, distributed under CCP's EVE Online Developer
 * License (see data/SDE-LICENSE.md) — it is NOT covered by this package's GPL
 * and is included by mere aggregation. To run against a fresher/custom SDE,
 * build your own FittingDataset and use the base entry's `computeFit` directly.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeFit, type ComputeFitOptions } from './engine'
import { parseEft } from './eft/parser'
import { defaultStateForModule } from './fitChecks'
import type {
    BundleManifest, ComputedFit, Fit, FittingDataset, SdeType, SkillProfile, TypeBucket,
} from './types'

// Resolve the bundled data dir relative to this compiled module. tsup is
// configured with `shims: true`, so `import.meta.url` is available in both the
// ESM and CJS outputs. dist/node.{js,cjs} -> ../data.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = path.resolve(MODULE_DIR, '..', 'data')

/**
 * Absolute path to the bundled SDE directory shipped in this package
 * (`<pkg>/data`, layout: manifest.json + v<hash>/...). Exported so a consumer
 * can serve these files directly (e.g. an HTTP static route for a browser UI)
 * and treat the package as the single source of fitting data.
 */
export const BUNDLED_DATA_DIR = DEFAULT_DATA_DIR

const BUCKET_FILES: Record<TypeBucket, string> = {
    ships: 'types/ships.json', modules: 'types/modules.json', charges: 'types/charges.json',
    drones: 'types/drones.json', fighters: 'types/fighters.json', implants: 'types/implants.json',
    subsystems: 'types/subsystems.json', skills: 'types/skills.json',
    systemEffects: 'types/system-effects.json', structures: 'types/structures.json',
    structureModules: 'types/structure-modules.json', mutaplasmids: 'types/mutaplasmids.json',
}
const OPTIONAL: ReadonlySet<TypeBucket> = new Set<TypeBucket>(['systemEffects', 'structures', 'structureModules', 'mutaplasmids'])

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf-8')) as T
function toMap<V extends { id: number }>(rec: Record<string, V>): Map<number, V> {
    const m = new Map<number, V>()
    for (const k in rec) m.set(Number(k), rec[k]!)
    return m
}

const cache = new Map<string, Promise<FittingDataset>>()

/**
 * Load the SDE bundle shipped inside this package into a `FittingDataset`.
 * Cached per directory. Pass `dataDir` to point at a different bundle (same
 * manifest + v<hash>/ layout produced by the capsuleers.app bundle builder).
 */
export function loadBundledDataset(dataDir: string = DEFAULT_DATA_DIR): Promise<FittingDataset> {
    const hit = cache.get(dataDir)
    if (hit) return hit
    const build = (async (): Promise<FittingDataset> => {
        const manifest = await readJson<BundleManifest>(path.join(dataDir, 'manifest.json'))
        const vdir = path.join(dataDir, `v${manifest.version}`)
        const base = async <T extends { id: number }>(f: string) => toMap(await readJson<Record<string, T>>(path.join(vdir, f)))
        const [attributes, units, effects, metaGroups, categories, groups, marketGroups, cloneGrades, dbuffCollections, dynamicAttributes] = await Promise.all([
            base<any>('attributes.json'), base<any>('units.json'), base<any>('effects.json'),
            base<any>('meta-groups.json'), base<any>('categories.json'), base<any>('groups.json'),
            base<any>('market-groups.json').catch(() => new Map()),
            base<any>('clone-grades.json'), base<any>('dbuff-collections.json'), base<any>('dynamic-attributes.json'),
        ])
        const typesByBucket: Partial<Record<TypeBucket, Map<number, SdeType>>> = {}
        await Promise.all((Object.keys(BUCKET_FILES) as TypeBucket[]).map(async (b) => {
            try { typesByBucket[b] = await base<SdeType>(BUCKET_FILES[b]) }
            catch (e) { if (OPTIONAL.has(b)) typesByBucket[b] = new Map(); else throw e }
        }))
        return {
            version: manifest.version,
            attributes, units, effects, metaGroups, categories, groups, marketGroups,
            cloneGrades, dbuffCollections, dynamicAttributes, typesByBucket,
            getType(id: number): SdeType | undefined {
                for (const b in typesByBucket) { const t = typesByBucket[b as TypeBucket]?.get(id); if (t) return t }
                return undefined
            },
            async loadBucket(b: TypeBucket): Promise<Map<number, SdeType>> { return typesByBucket[b] ?? new Map() },
        } as FittingDataset
    })().catch((err) => { cache.delete(dataDir); throw err })
    cache.set(dataDir, build)
    return build
}

/** All-V skill profile built from the dataset's skills bucket (Pyfa headline). */
export function buildAllVSkillProfile(dataset: FittingDataset): SkillProfile {
    const skills: Record<number, 0 | 1 | 2 | 3 | 4 | 5> = {}
    const bucket = dataset.typesByBucket.skills
    if (bucket) for (const id of bucket.keys()) skills[id] = 5
    return { name: 'All V', isDefault: true, source: 'preset', skills }
}

export interface ComputeFromEftResult {
    fit: Fit
    warnings: Array<{ line: number; text: string; reason: string }>
    computed: ComputedFit
}

/**
 * One-call: EFT text -> full computed stats, using the bundled SDE.
 * Defaults to All-V skills (override via `options.skillProfile`).
 */
export async function computeFromEft(
    eft: string,
    options: Partial<ComputeFitOptions> = {},
): Promise<ComputeFromEftResult> {
    const dataset = await loadBundledDataset()
    const { fit, warnings } = parseEft(eft, dataset)
    // Promote modules to their natural state (ACTIVE for weapons/props/hardeners
    // with an activation effect), mirroring what the editor does after an EFT
    // import — otherwise weapons sit ONLINE and contribute 0 DPS.
    for (const m of fit.modules) {
        const t = dataset.getType(m.typeID)
        if (t) m.state = defaultStateForModule(t, dataset.effects)
    }
    const skillProfile = options.skillProfile ?? buildAllVSkillProfile(dataset)
    const computed = computeFit(fit, dataset, { ...options, skillProfile })
    return { fit, warnings, computed }
}

// Re-export the full base surface so a consumer of `/node` gets everything.
export * from './index'
