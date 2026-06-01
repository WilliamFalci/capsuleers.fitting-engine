/**
 * Effect coverage audit — verifies that every SDE effect referenced by a
 * fittable type either has data-driven modifierInfo (caught by the generic
 * dispatcher) OR is registered in LEGACY_EFFECT_IDS / OUT_OF_SCOPE_EFFECT_IDS.
 *
 * The output's headline metric is `truly silent (real gaps)`. When this
 * number is zero, every fittable effect is either implemented, deliberately
 * deferred, or a documented SDE marker.
 *
 * Usage:  tsx .test/effect-coverage-audit.ts
 *
 * Re-create from this file's git blame if it's been deleted between audits.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    LEGACY_EFFECT_IDS,
    OUT_OF_SCOPE_EFFECT_IDS,
    SLOT_EFFECT_TO_SLOT_TYPE,
    WEAPON_EFFECT_KIND,
    ACTIVATION_EFFECT_ID,
    LEGACY_HANDLED_EFFECT_IDS,
} from '../src/index'

/** SDE marker effects: empty modifierInfo by design because they're dispatch
 *  flags consumed by non-modifier engine paths (slot routing in `engine.ts`,
 *  weapon-cycle dispatch in `derived/offense.ts`, online-state gating in
 *  `itemState.ts`). They are NOT "silent" in the gap-coverage sense — they
 *  have meaningful semantics and are read by the engine, just not via the
 *  modifierInfo dispatcher. Build the set from the existing single-source-
 *  of-truth registries so a new marker added there flows through here for
 *  free. */
const sdeMarkerIds = new Set<number>([
    ...Object.keys(SLOT_EFFECT_TO_SLOT_TYPE).map(Number),
    ...Object.keys(WEAPON_EFFECT_KIND).map(Number),
    ACTIVATION_EFFECT_ID.ONLINE,
])

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const BUNDLE_ROOT = (() => {
    const manifestPath = join(DATA_DIR, 'manifest.json')
    if (!existsSync(manifestPath)) {
        throw new Error(`SDE bundle manifest missing at ${manifestPath} — run npm run build:data first`)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
    return join(DATA_DIR, `v${manifest.version}`)
})()

interface EffectRow {
    id: number
    name: string
    effectCategoryID: number
    modifierInfo: unknown[]
}

interface TypeRow {
    id: number
    name: string
    groupID: number
    categoryID: number
    effects?: Array<{ id: number }>
}

const effects = (() => {
    const raw = JSON.parse(readFileSync(join(BUNDLE_ROOT, 'effects.json'), 'utf8')) as Record<string, EffectRow>
    return new Map<number, EffectRow>(Object.values(raw).map((e) => [e.id, e]))
})()

const TYPE_FILES = ['ships', 'modules', 'charges', 'drones', 'fighters', 'subsystems', 'skills', 'implants', 'system-effects', 'structures', 'structure-modules'] as const
const allTypes: TypeRow[] = []
const effectUsage = new Map<number, Set<number>>() // effectID -> set<typeID>

for (const file of TYPE_FILES) {
    const raw = JSON.parse(readFileSync(join(BUNDLE_ROOT, 'types', `${file}.json`), 'utf8')) as Record<string, TypeRow>
    for (const t of Object.values(raw)) {
        allTypes.push(t)
        for (const e of t.effects ?? []) {
            let s = effectUsage.get(e.id)
            if (!s) { s = new Set(); effectUsage.set(e.id, s) }
            s.add(t.id)
        }
    }
}

const legacyIds = new Set<number>(LEGACY_EFFECT_IDS.map((e) => e.id))
const oosIds = new Set<number>(OUT_OF_SCOPE_EFFECT_IDS.map((e) => e.id))

let dataDriven = 0           // non-empty modifierInfo
let emptyModInfoTotal = 0    // empty modifierInfo, total
let emptyModInfoUnused = 0   // empty modifierInfo + zero references in fittable types
let coveredByLegacy = 0
let coveredByOos = 0
let coveredBySdeMarker = 0
let trulySilent: EffectRow[] = []

for (const eff of effects.values()) {
    const isEmpty = !Array.isArray(eff.modifierInfo) || eff.modifierInfo.length === 0
    if (!isEmpty) { dataDriven += 1; continue }
    emptyModInfoTotal += 1
    const usage = effectUsage.get(eff.id)
    if (!usage || usage.size === 0) { emptyModInfoUnused += 1; continue }
    if (sdeMarkerIds.has(eff.id)) { coveredBySdeMarker += 1; continue }
    if (legacyIds.has(eff.id)) { coveredByLegacy += 1; continue }
    if (oosIds.has(eff.id)) { coveredByOos += 1; continue }
    trulySilent.push(eff)
}

trulySilent.sort((a, b) => (effectUsage.get(b.id)!.size) - (effectUsage.get(a.id)!.size))

// Drift checks
const legacyMissingFromSde: number[] = []
const oosMissingFromSde: number[] = []
for (const e of LEGACY_EFFECT_IDS) if (!effects.has(e.id)) legacyMissingFromSde.push(e.id)
for (const e of OUT_OF_SCOPE_EFFECT_IDS) if (!effects.has(e.id)) oosMissingFromSde.push(e.id)

console.log('=== Effect coverage audit ===')
console.log(`SDE bundle:               ${BUNDLE_ROOT}`)
console.log(`Total effects:            ${effects.size}`)
console.log(`  data-driven:            ${dataDriven}`)
console.log(`  empty modifierInfo:     ${emptyModInfoTotal}`)
console.log(`    unused (no fittable type references): ${emptyModInfoUnused}`)
console.log(`    covered by SDE markers (slot/weapon-fire/online dispatch): ${coveredBySdeMarker}`)
console.log(`    covered by LEGACY_EFFECT_IDS:         ${coveredByLegacy}`)
console.log(`    covered by OUT_OF_SCOPE_EFFECT_IDS:   ${coveredByOos}`)
console.log(`    truly silent (real gaps):             ${trulySilent.length}`)
console.log()
console.log(`LEGACY_EFFECT_IDS entries:        ${LEGACY_EFFECT_IDS.length}`)
console.log(`OUT_OF_SCOPE_EFFECT_IDS entries:  ${OUT_OF_SCOPE_EFFECT_IDS.length}`)
console.log(`Legacy IDs missing from SDE:      ${legacyMissingFromSde.length}${legacyMissingFromSde.length ? ' [' + legacyMissingFromSde.join(',') + ']' : ''}`)
console.log(`OOS IDs missing from SDE:         ${oosMissingFromSde.length}${oosMissingFromSde.length ? ' [' + oosMissingFromSde.join(',') + ']' : ''}`)
console.log()

// Drift cross-check 1: legacy IDs whose effect has NON-empty modifierInfo —
// risk of double-handling (legacy handler + generic dispatcher both fire) UNLESS
// the ID is in the LEGACY_HANDLED_EFFECT_IDS skip set, which tells the
// dispatcher to leave it to the legacy handler. Only effects NOT in the skip
// set are real warnings (Bastion bug class). Effects already in the skip set
// are reported as INFO only.
const legacyNonEmptyRisks: number[] = []
const legacyNonEmptyOk: number[] = []
for (const e of LEGACY_EFFECT_IDS) {
    const eff = effects.get(e.id)
    if (!eff) continue
    const isEmpty = !Array.isArray(eff.modifierInfo) || eff.modifierInfo.length === 0
    if (isEmpty) continue
    if (LEGACY_HANDLED_EFFECT_IDS.has(e.id)) legacyNonEmptyOk.push(e.id)
    else legacyNonEmptyRisks.push(e.id)
}
if (legacyNonEmptyRisks.length > 0) {
    console.log(`WARN — Legacy IDs with non-empty modifierInfo NOT in LEGACY_HANDLED_EFFECT_IDS skip set:`)
    for (const id of legacyNonEmptyRisks) {
        const eff = effects.get(id)!
        console.log(`  - ${id} \`${eff.name}\` (modifierInfo entries: ${(eff.modifierInfo as unknown[]).length}) — ADD TO SKIP SET or remove from LEGACY_EFFECT_IDS`)
    }
    console.log()
}
if (legacyNonEmptyOk.length > 0) {
    console.log(`INFO — Legacy IDs with non-empty modifierInfo correctly skipped by the dispatcher (${legacyNonEmptyOk.length}):`)
    for (const id of legacyNonEmptyOk) console.log(`  - ${id} \`${effects.get(id)!.name}\``)
    console.log()
}

// Drift cross-check 2: legacy IDs that no fittable type in the bundle uses.
// The handler is registered correctly but the input never arrives — usually
// because the type that would carry the effect isn't in our bundle (Standup
// Upwell structure modules are the canonical example).
const legacyUnreferenced: number[] = []
for (const e of LEGACY_EFFECT_IDS) {
    if (!effects.has(e.id)) continue
    if (!effectUsage.has(e.id) || effectUsage.get(e.id)!.size === 0) legacyUnreferenced.push(e.id)
}
if (legacyUnreferenced.length > 0) {
    const structureLike = legacyUnreferenced.filter((id) => /structure|upwell|standup/i.test(effects.get(id)?.name ?? ''))
    const others = legacyUnreferenced.filter((id) => !structureLike.includes(id))
    if (structureLike.length > 0) {
        console.log(`INFO — Legacy IDs unreferenced because Upwell-structure modules aren't in this bundle (${structureLike.length}):`)
        for (const id of structureLike) console.log(`  - ${id} \`${effects.get(id)!.name}\``)
        console.log()
    }
    if (others.length > 0) {
        console.log(`WARN — Legacy IDs not referenced by any fittable type (potential dead handler):`)
        for (const id of others) console.log(`  - ${id} \`${effects.get(id)?.name ?? '?'}\``)
        console.log()
    }
}

if (trulySilent.length === 0) {
    console.log('OK — every fittable effect is either data-driven, hardcoded (LEGACY_EFFECT_IDS),')
    console.log('     or deliberately documented as out-of-scope (OUT_OF_SCOPE_EFFECT_IDS).')
} else {
    console.log('GAPS — the following effects are referenced by fittable types but have empty')
    console.log('       modifierInfo AND no entry in LEGACY_EFFECT_IDS / OUT_OF_SCOPE_EFFECT_IDS.')
    console.log()
    console.log('| effect_id | name | category | items_using_it | sample_type_ids |')
    console.log('|-----------|------|----------|----------------|------------------|')
    for (const eff of trulySilent.slice(0, 60)) {
        const users = Array.from(effectUsage.get(eff.id)!).slice(0, 3).join(', ')
        const usageCount = effectUsage.get(eff.id)!.size
        console.log(`| ${eff.id} | \`${eff.name}\` | ${eff.effectCategoryID} | ${usageCount} | ${users} |`)
    }
    if (trulySilent.length > 60) console.log(`... ${trulySilent.length - 60} more`)
    process.exitCode = 1
}
