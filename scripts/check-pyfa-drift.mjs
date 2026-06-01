/**
 * Pyfa drift detector.
 *
 * Fetches the canonical Pyfa `eos/effects.py`, extracts every hardcoded
 * `class Effect<N>(BaseEffect)` ID (these are the effects whose semantics live
 * in hand-written Python rather than data-driven SDE `modifierInfo`), and:
 *
 *   1. Diffs the set against a committed snapshot (effects-snapshot.json) →
 *      reports effect IDs Pyfa ADDED or REMOVED since the last run.
 *   2. Cross-references against THIS package's LEGACY_EFFECT_IDS registry →
 *      flags newly-added Pyfa hardcoded effects that we do NOT yet cover
 *      (candidates for a new applyLegacy* handler) and changed effects we DO
 *      cover (re-verify parity).
 *
 * This is the realistic "auto-update" surface: SDE balance changes flow through
 * the data bundle automatically, but NEW hardcoded mechanics in effects.py are
 * code and need a human (assisted by this report) to port + re-run parity.
 *
 *   node scripts/check-pyfa-drift.mjs            # report only
 *   node scripts/check-pyfa-drift.mjs --update   # rewrite the snapshot
 *
 * Exit code: 0 = no drift, 2 = drift detected (CI opens an issue), 1 = error.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_EFFECT_IDS } from '../dist/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = path.join(HERE, 'effects-snapshot.json')
const EFFECTS_URL = 'https://raw.githubusercontent.com/pyfa-org/Pyfa/master/eos/effects.py'

/** Parse `class Effect<N>(BaseEffect):` + the docstring name on the next line. */
function parseEffectsPy(src) {
    const out = {}
    const re = /class Effect(\d+)\(BaseEffect\):\s*\n\s*(?:"""(.*?)"""|'''(.*?)''')?/gs
    let m
    while ((m = re.exec(src)) !== null) {
        const id = Number(m[1])
        // Keep only the first docstring line (the effect name); Pyfa docstrings
        // also embed a verbose "Used by:" group dump we don't need in the diff.
        const name = ((m[2] ?? m[3] ?? '').trim().split('\n')[0] ?? '').trim() || null
        out[id] = name
    }
    return out
}

async function main() {
    const update = process.argv.includes('--update')

    const res = await fetch(EFFECTS_URL)
    if (!res.ok) { console.error(`fetch effects.py -> ${res.status}`); process.exit(1) }
    const src = await res.text()
    const current = parseEffectsPy(src)
    const currentIds = new Set(Object.keys(current).map(Number))
    console.log(`Pyfa effects.py: ${currentIds.size} hardcoded Effect classes.`)

    let prev = {}
    try { prev = JSON.parse(await fs.readFile(SNAPSHOT, 'utf-8')).effects ?? {} } catch { /* first run */ }
    const prevIds = new Set(Object.keys(prev).map(Number))

    const added = [...currentIds].filter(id => !prevIds.has(id)).sort((a, b) => a - b)
    const removed = [...prevIds].filter(id => !currentIds.has(id)).sort((a, b) => a - b)
    const renamed = [...currentIds].filter(id => prevIds.has(id) && prev[id] !== current[id])

    // Which IDs does THIS package hardcode?
    const ours = new Set(LEGACY_EFFECT_IDS.map(e => e.id))

    const addedUncovered = added.filter(id => !ours.has(id))
    const renamedCovered = renamed.filter(id => ours.has(id))

    let drift = false
    const line = (s) => console.log(s)

    if (added.length) {
        drift = true
        line(`\n➕ ${added.length} effect(s) ADDED upstream:`)
        // NOTE: Pyfa hardcodes ~2350 effects; we only HARDCODE ~85 (the rest we
        // handle data-driven via SDE modifierInfo). So "not in our hardcoded set"
        // means "verify whether this new effect is data-driven or needs an
        // applyLegacy* handler" — not "unhandled".
        for (const id of added) line(`   Effect${id}  "${current[id] ?? ''}"${ours.has(id) ? '  (we hardcode this id — re-verify)' : '  → not in our hardcoded set; check data-driven vs needs-handler'}`)
    }
    if (removed.length) {
        drift = true
        line(`\n➖ ${removed.length} effect(s) REMOVED upstream:`)
        for (const id of removed) line(`   Effect${id}  "${prev[id] ?? ''}"${ours.has(id) ? '  ⚠ WE STILL HARDCODE THIS — review' : ''}`)
    }
    if (renamedCovered.length) {
        drift = true
        line(`\n✏  ${renamedCovered.length} effect(s) we cover were RENAMED/changed upstream — re-verify parity:`)
        for (const id of renamedCovered) line(`   Effect${id}: "${prev[id]}" -> "${current[id]}"`)
    }

    if (!drift) {
        line('\n✅ No drift vs snapshot. Pyfa hardcoded-effect set unchanged.')
    } else {
        line(`\nSummary: ${added.length} added (${addedUncovered.length} uncovered), ${removed.length} removed, ${renamedCovered.length} covered-and-changed.`)
        line('Action: port/verify the affected applyLegacy* handlers, then re-run `npm run test:pyfa` in the app before release.')
    }

    if (update) {
        await fs.writeFile(SNAPSHOT, JSON.stringify({ source: EFFECTS_URL, count: currentIds.size, effects: current }, null, 2) + '\n')
        line(`\nSnapshot rewritten (${currentIds.size} effects).`)
        process.exit(0)
    }

    process.exit(drift ? 2 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
