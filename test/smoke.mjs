/**
 * Runtime smoke test for the BUILT package (dist/index.js) — the BASE entry,
 * the one a browser/bundler consumer gets. It has no fs and no loader, so the
 * dataset has to be handed to it.
 *
 * That is the second thing this test pins, and why it does NOT just call
 * `loadBundledDataset`: it hand-builds a `FittingDataset` from raw JSON exactly
 * the way a browser consumer must (capsuleers.app's client does this over
 * fetch). If the shape the engine expects ever drifts from the shape a consumer
 * can assemble, this breaks — `dist/node.js` would not notice, because it
 * builds that object itself.
 *
 * The bundle is the one shipped inside this package (`<pkg>/data`); before the
 * SDE moved in here it lived in the consuming app, and the default path still
 * pointed at a checkout that no longer exists — so this test failed on every
 * machine and was in no gate to say so. Override with FIT_BUNDLE_DIR to run it
 * against a different bundle of the same layout:
 *
 *   FIT_BUNDLE_DIR=/path/to/fitting-data node test/smoke.mjs
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeFit } from '../dist/index.js'

const BUNDLE_DIR = process.env.FIT_BUNDLE_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

const BUCKET_FILES = {
    ships: 'types/ships.json', modules: 'types/modules.json', charges: 'types/charges.json',
    drones: 'types/drones.json', fighters: 'types/fighters.json', implants: 'types/implants.json',
    subsystems: 'types/subsystems.json', skills: 'types/skills.json',
    systemEffects: 'types/system-effects.json', structures: 'types/structures.json',
    structureModules: 'types/structure-modules.json', mutaplasmids: 'types/mutaplasmids.json',
}
const OPTIONAL = new Set(['systemEffects', 'structures', 'structureModules', 'mutaplasmids'])

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf-8'))
const toMap = (rec) => { const m = new Map(); for (const k in rec) m.set(Number(k), rec[k]); return m }

async function buildDataset() {
    const manifest = await readJson(path.join(BUNDLE_DIR, 'manifest.json'))
    const vdir = path.join(BUNDLE_DIR, `v${manifest.version}`)
    const base = async (f) => toMap(await readJson(path.join(vdir, f)))
    const [attributes, units, effects, metaGroups, categories, groups, marketGroups, cloneGrades, dbuffCollections, dynamicAttributes] = await Promise.all([
        base('attributes.json'), base('units.json'), base('effects.json'), base('meta-groups.json'),
        base('categories.json'), base('groups.json'), base('market-groups.json').catch(() => new Map()),
        base('clone-grades.json'), base('dbuff-collections.json'), base('dynamic-attributes.json'),
    ])
    const typesByBucket = {}
    await Promise.all(Object.entries(BUCKET_FILES).map(async ([b, f]) => {
        try { typesByBucket[b] = await base(f) } catch (e) { if (OPTIONAL.has(b)) typesByBucket[b] = new Map(); else throw e }
    }))
    return {
        version: manifest.version, attributes, units, effects, metaGroups, categories, groups,
        marketGroups, cloneGrades, dbuffCollections, dynamicAttributes, typesByBucket,
        getType(id) { for (const b in typesByBucket) { const t = typesByBucket[b].get(id); if (t) return t } return undefined },
        async loadBucket(b) { return typesByBucket[b] ?? new Map() },
    }
}

function allVSkills(dataset) {
    const skills = {}
    for (const id of dataset.typesByBucket.skills.keys()) skills[id] = 5
    return { name: 'All V', isDefault: true, source: 'preset', skills }
}

function bareFit(shipTypeID, name) {
    return { shipTypeID, name, visibility: 'PRIVATE', tags: [], modules: [], drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [] }
}

const ds = await buildDataset()
const skillProfile = allVSkills(ds)

let failures = 0
const check = (label, ok, val) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${val}`); if (!ok) failures++ }

// Rifter (587) and Raven (638): bare hulls, All-V. Just assert the derived block
// is populated with finite, positive base stats — proves the dist artifact runs.
for (const [id, label] of [[587, 'Rifter'], [638, 'Raven']]) {
    const c = computeFit(bareFit(id, label), ds, { skillProfile })
    const d = c.derived
    check(`${label} EHP total`, Number.isFinite(d.defense.ehpTotalAgainstProfile) && d.defense.ehpTotalAgainstProfile > 0, d.defense.ehpTotalAgainstProfile?.toFixed(0))
    check(`${label} capacitor cap`, Number.isFinite(d.capacitor.capacity) && d.capacitor.capacity > 0, d.capacitor.capacity?.toFixed(0))
    check(`${label} max velocity`, Number.isFinite(d.navigation.maxVelocity) && d.navigation.maxVelocity > 0, d.navigation.maxVelocity?.toFixed(1))
    check(`${label} CPU max`, Number.isFinite(d.fitting.cpuMax) && d.fitting.cpuMax > 0, d.fitting.cpuMax?.toFixed(1))
}

console.log(`\nSmoke summary: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
