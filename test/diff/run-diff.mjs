/**
 * Differential Pyfa-parity harness.
 *
 * For every ship, generate 4 fits (fit-generator), compute each with OUR engine
 * and with pyfa-org/Pyfa (oracle/pyfa_oracle.py via the .pyfa venv), diff the
 * stats (stat-schema), and print every difference. Exit 1 if any difference is
 * found beyond tolerance — so it can drive a /goal verify-and-fix loop.
 *
 *   npm run diff                       # all ships, generated corpus
 *   npm run diff -- --source=workbench # real published fits (see fit-sources)
 *   npm run diff -- --source=implants  # implant sets + boosters
 *   npm run diff -- --source=all       # every corpus in one run
 *   npm run diff -- --ships=587,29990  # specific ships
 *   npm run diff -- --limit=20         # first N ships
 *   npm run diff -- --group=Loki       # ship group name contains "Loki"
 *   npm run diff -- --tol=0.02 --json  # custom tolerance / machine output
 *   npm run diff -- --only=bonused     # only one fit type
 *   npm run diff -- --stats=offense,defense  # only some stat groups
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadBundledDataset, buildAllVSkillProfile } from '../../dist/node.js'
import { computeFit, DAMAGE_PROFILE_PRESETS } from '../../dist/index.js'
import { generateFits } from './fit-generator.mjs'
import { loadWorkbenchFits, generateImplantFits, generateImplantMatrix } from './fit-sources.mjs'
import { oursToSchema, flatten, diffStats } from './stat-schema.mjs'
import { isKnownDiff, knownDiffReason, KNOWN_DIFFS } from './known-diffs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PYFA = resolve(HERE, '../../.pyfa')

function parseArgs(argv) {
    const a = { tol: 0.01, eps: 0.01, source: 'generated' }
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); if (!m) continue
        const [, k, v] = m
        if (k === 'ships') a.ships = v.split(',').map(Number)
        else if (k === 'limit') a.limit = Number(v)
        else if (k === 'group') a.group = v.toLowerCase()
        else if (k === 'tol') a.tol = Number(v)
        else if (k === 'only') a.only = v.split(',')
        else if (k === 'stats') a.stats = v.split(',')
        else if (k === 'json') a.json = true
        else if (k === 'strict') a.strict = true
        else if (k === 'source') a.source = v
        else if (k === 'per-hull') a.perHull = Number(v)
    }
    return a
}

function resolveShips(dataset, args) {
    let ships = [...(dataset.typesByBucket.ships?.values() ?? [])].filter(t => t.published !== false)
    if (args.ships) { const set = new Set(args.ships); ships = ships.filter(s => set.has(s.id)) }
    if (args.group) ships = ships.filter(s => (dataset.groups.get(s.groupID)?.name ?? '').toLowerCase().includes(args.group))
    ships.sort((a, b) => a.id - b.id)
    if (args.limit) ships = ships.slice(0, args.limit)
    return ships
}

const toOurFit = (spec) => ({
    shipTypeID: spec.shipTypeID, name: spec.fitType, visibility: 'PRIVATE', tags: [],
    modules: spec.modules, cargo: [],
    fighters: (spec.fighters ?? []).map((f, i) => ({ id: `f${i}`, typeID: f.typeID, count: f.count, abilityState: {} })),
    implants: (spec.implants ?? []).map((im, i) => ({ id: `i${i}`, typeID: im.typeID, slot: im.slot ?? i + 1 })),
    boosters: (spec.boosters ?? []).map((b, i) => ({ id: `b${i}`, typeID: b.typeID, slot: b.slot ?? i + 1, activeSideEffects: b.activeSideEffects ?? [] })),
    drones: spec.drones.map((d, i) => ({ id: `d${i}`, typeID: d.typeID, countTotal: d.count, countActive: d.active })),
    subsystems: spec.subsystems.map((s, i) => ({ id: `s${i}`, slot: i + 1, typeID: s.typeID })),
    modeTypeID: spec.modeTypeID,
})
const toOracleSpec = (spec, id) => ({
    id, shipTypeID: spec.shipTypeID,
    modules: spec.modules.map(m => ({ typeID: m.typeID, state: m.state, chargeTypeID: m.chargeTypeID })),
    drones: spec.drones, subsystems: spec.subsystems, modeTypeID: spec.modeTypeID,
    fighters: spec.fighters ?? [],
    implants: (spec.implants ?? []).map(im => ({ typeID: im.typeID })),
    boosters: (spec.boosters ?? []).map(b => ({ typeID: b.typeID, sideEffects: b.activeSideEffects ?? [] })),
})

function callOracle(payload) {
    const py = resolve(PYFA, '.venv/bin/python')
    const res = spawnSync(py, [resolve(HERE, '../../oracle/pyfa_oracle.py')], {
        cwd: PYFA,
        env: { ...process.env, PYTHONPATH: `${PYFA}:${resolve(PYFA, '_oracle_stubs')}` },
        input: JSON.stringify(payload), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
    })
    if (res.status !== 0) {
        console.error('[oracle] failed:', res.stderr?.slice(-2000))
        process.exit(2)
    }
    return JSON.parse(res.stdout)
}

function runOracle(specs) {
    return new Map(callOracle(specs).map(r => [r.id, r]))
}

/**
 * Which of these typeIDs the pinned pyfa staticdata can supply.
 *
 * pyfa's SDE snapshot trails CCP's by weeks, so our freshly-rebuilt bundle
 * knows items it has never heard of. Asking before building the corpus lets a
 * source leave them out and DECLARE it, rather than emitting fits that come
 * back incomparable — a skipped fit and an excluded item cost the same
 * coverage, but only one of them is legible in the report.
 */
function oracleKnownTypes(typeIDs) {
    const { known } = callOracle({ op: 'known', typeIDs: [...typeIDs] })
    return new Set(known)
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!existsSync(resolve(PYFA, 'eve.db'))) {
        console.error('Oracle not set up. Run: npm run diff:setup'); process.exit(2)
    }
    const dataset = await loadBundledDataset()
    const ALLV = buildAllVSkillProfile(dataset)
    // The oracle sets a Uniform 25/25/25/25 damagePattern; pass the same so a
    // Reactive Armor Hardener adapts identically (without a profile our RAH
    // stays at base resonances and contributes nothing) and EHP is comparable.
    const UNIFORM = DAMAGE_PROFILE_PRESETS.find(p => p.name === 'Uniform')
    const ships = resolveShips(dataset, args)
    const sources = args.source === 'all'
        ? ['generated', 'workbench', 'implants']
        : args.source.split(',')
    console.error(`[diff] ${ships.length} ships, source=${sources.join('+')}, tol=${args.tol}`)

    // Build the corpus: every source emits the same engine-agnostic spec, so
    // both engines are handed identical input and any difference is engine math.
    const specs = []          // { ship, spec }
    const corpusNotes = []
    for (const source of sources) {
        if (source === 'generated') {
            for (const ship of ships) {
                try {
                    for (const spec of generateFits(dataset, ship, computeFit, ALLV)) specs.push({ ship, spec })
                } catch (e) { console.error(`[gen] ${ship.name}: ${e.message}`) }
            }
        } else if (source === 'workbench') {
            const shipIds = new Set(ships.map(s => s.id))
            const { fits, failures, missing } = loadWorkbenchFits(dataset, computeFit, ALLV,
                { perHull: args.perHull ?? 3 })
            if (missing) {
                corpusNotes.push('workbench corpus absent — run `npm run corpus:fetch` (needs EVEWORKBENCH_API_KEY)')
            }
            for (const spec of fits) {
                if (!shipIds.has(spec.shipTypeID)) continue
                const ship = dataset.typesByBucket.ships.get(spec.shipTypeID)
                specs.push({ ship, spec })
            }
            // A fit we cannot parse is a hole in coverage, not a pass: say so.
            if (failures.length) {
                corpusNotes.push(`workbench: ${failures.length} fit(s) unparseable — ${failures.slice(0, 3).map(f => `${f.ship}: ${f.reason}`).join('; ')}${failures.length > 3 ? ', …' : ''}`)
            }
            const hulls = new Set(fits.map(f => f.shipTypeID)).size
            console.error(`[diff]   workbench: ${fits.length} real fits across ${hulls} hulls`)
        } else if (source === 'implants') {
            // The FULL matrix once, on the first hull in the run, so every set
            // and every booster is compared at least once whatever the ship
            // filter; then a rotating slice per hull for breadth.
            const [ref, ...rest] = ships
            const built = []
            if (ref) for (const spec of generateImplantMatrix(dataset, ref)) built.push({ ship: ref, spec })
            rest.forEach((ship, i) => {
                for (const spec of generateImplantFits(dataset, ship, i)) built.push({ ship, spec })
            })
            // Drop the fits naming an item the oracle cannot supply, and say how
            // many and which — those are pyfa staticdata gaps, not engine diffs.
            const wanted = new Set()
            for (const { spec } of built) {
                for (const im of spec.implants ?? []) wanted.add(im.typeID)
                for (const b of spec.boosters ?? []) wanted.add(b.typeID)
            }
            const known = oracleKnownTypes(wanted)
            const absent = new Set()
            let kept = 0
            for (const entry of built) {
                const ids = [...(entry.spec.implants ?? []).map(i => i.typeID),
                             ...(entry.spec.boosters ?? []).map(b => b.typeID)]
                const missing = ids.filter(id => !known.has(id))
                if (missing.length) { for (const id of missing) absent.add(id) ; continue }
                specs.push(entry); kept++
            }
            if (absent.size) {
                corpusNotes.push(`implants: ${absent.size} item(s) absent from the pinned pyfa staticdata — excluded (pyfa's SDE trails CCP's; not an engine difference)`)
            }
            console.error(`[diff]   implants: full matrix on ${ref?.name ?? '—'} + rotating slice on ${rest.length} hulls → ${kept} comparable fits`)
        } else {
            console.error(`[diff] unknown source "${source}"`); process.exit(2)
        }
    }

    // Our compute; collect oracle specs.
    const items = []   // { id, ship, fitType, oursFlat }
    const oracleSpecs = []
    for (const { ship, spec } of specs) {
        if (args.only && !args.only.includes(spec.fitType)) continue
        const id = `${ship.id}:${spec.fitType}`
        let oursFlat = null
        try {
            const c = computeFit(toOurFit(spec), dataset, { skillProfile: ALLV, damageProfile: UNIFORM })
            oursFlat = flatten(oursToSchema(c.derived))
        } catch (e) { oursFlat = { __error: e.message } }
        items.push({ id, ship, fitType: spec.fitType, oursFlat })
        oracleSpecs.push(toOracleSpec(spec, id))
    }

    console.error(`[diff] running oracle on ${oracleSpecs.length} fits...`)
    const oracle = runOracle(oracleSpecs)

    // Diff.
    const allDiffs = []   // { ship, fitType, key, ours, pyfa, pctDelta }
    const driftByType = new Map()   // typeID -> { typeID, kind, name, fits: string[] }
    let okFits = 0, oracleFail = 0, ourFail = 0, oracleSkipped = 0
    for (const it of items) {
        const o = oracle.get(it.id)
        if (it.oursFlat.__error) { ourFail++; continue }
        if (!o || !o.ok) { oracleFail++; continue }
        // The pinned pyfa staticdata didn't know some type this fit uses, so the
        // oracle silently fitted one item FEWER — the two sides computed
        // different fits and every resulting stat delta is an artefact. Record
        // it as pin drift and skip; diffing it would manufacture phantom diffs
        // (that is exactly how a new Damage Control module once produced 36).
        if (o.dropped?.length) {
            oracleSkipped++
            for (const d of o.dropped) {
                const e = driftByType.get(d.typeID)
                    ?? { typeID: d.typeID, kind: d.kind, name: typeName(dataset, d.typeID), fits: [] }
                e.fits.push(`${it.ship.name} / ${it.fitType}`)
                driftByType.set(d.typeID, e)
            }
            continue
        }
        let pyfaFlat = flatten(o.stats)
        if (args.stats) {
            const keep = (k) => args.stats.some(g => k.startsWith(g))
            pyfaFlat = Object.fromEntries(Object.entries(pyfaFlat).filter(([k]) => keep(k)))
        }
        const diffs = diffStats(it.oursFlat, pyfaFlat, { tol: args.tol, eps: args.eps })
        if (!diffs.length) okFits++
        for (const d of diffs) allDiffs.push({ ship: it.ship.name, shipId: it.ship.id, fitType: it.fitType, ...d })
    }

    // Partition into documented/accepted differences (pyfa float/modelling/
    // per-ship quirks — see known-diffs.mjs) and UNEXPECTED diffs. The run only
    // fails on unexpected diffs, so the harness still catches every new/real
    // divergence (including a regression that changes an accepted value). Pass
    // --strict to fail on any diff (ignore the known-diffs list).
    const unexpected = args.strict ? allDiffs : allDiffs.filter(d => !isKnownDiff(d))
    const accepted = args.strict ? [] : allDiffs.filter(isKnownDiff)
    const drift = [...driftByType.values()].sort((a, b) => b.fits.length - a.fits.length)

    report(unexpected, { total: items.length, okFits, oracleFail, ourFail, oracleSkipped, accepted, drift, corpusNotes }, args)
    // Drift fails the run too: a stale pin silently shrinks coverage, and the
    // report names the fix. It is reported SEPARATELY from stat diffs so a red
    // run is diagnosable at a glance ("bump the pin" vs "the engine moved").
    process.exit(unexpected.length || drift.length ? 1 : 0)
}

/** Resolve a typeID to a name across every dataset bucket (for drift reporting). */
function typeName(dataset, typeID) {
    for (const bucket of Object.values(dataset.typesByBucket ?? {})) {
        const t = bucket?.get?.(typeID)
        if (t?.name) return t.name
    }
    return '?'
}

function report(diffs, summary, args) {
    if (args.json) { console.log(JSON.stringify({ summary, diffs }, null, 2)); return }

    // Coverage caveats (a missing or partly-unparseable corpus). Printed FIRST
    // and never silently: a shrinking corpus that still says "no differences"
    // is the one failure this harness must not be able to produce.
    for (const note of summary.corpusNotes ?? []) console.log(`\n⚠️  ${note}`)

    // Types our SDE bundle has but the PINNED pyfa staticdata does not. This is
    // oracle staleness, NOT an engine regression — surfacing it separately is
    // what keeps CCP shipping a new item from looking like we broke something.
    const drift = summary.drift ?? []
    if (drift.length) {
        console.log(`\n=== ORACLE SDE DRIFT (${drift.length} type${drift.length === 1 ? '' : 's'} absent from the pinned pyfa) ===`)
        console.log(`  The pinned oracle cannot fit these, so ${summary.oracleSkipped} fit(s) were SKIPPED as not comparable.`)
        console.log('  Fix: bump PYFA_REF in .github/workflows/diff-parity.yml to a pyfa whose')
        console.log('  staticdata carries them, re-run `npm run diff:setup`, then `npm run diff:recalibrate`.')
        for (const d of drift) {
            console.log(`    ${String(d.typeID).padEnd(7)} ${String(d.name).padEnd(30)} ${String(d.kind).padEnd(10)} ${d.fits.length} fit${d.fits.length === 1 ? '' : 's'}: ${d.fits.slice(0, 4).join(', ')}${d.fits.length > 4 ? ', …' : ''}`)
        }
    }
    const fmt = (v) => v == null ? '—' : (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v))
    const accepted = summary.accepted ?? []

    // Accepted, documented differences (pyfa float / modelling / per-ship quirks
    // — see known-diffs.mjs). Shown for transparency; they do NOT fail the run.
    if (accepted.length) {
        console.log(`\n=== ACCEPTED known differences (${accepted.length}; documented in known-diffs.mjs) ===`)
        const byReason = new Map()
        for (const d of accepted) {
            const r = knownDiffReason(d) ?? 'documented'
            if (!byReason.has(r)) byReason.set(r, [])
            byReason.get(r).push(d)
        }
        for (const [reason, list] of byReason) {
            console.log(`  • ${reason}`)
            for (const d of list) console.log(`      ${String(d.ship).padEnd(22)} ${d.fitType.padEnd(12)} ${d.key}  ours=${fmt(d.ours)} pyfa=${fmt(d.pyfa)}`)
        }
    }

    // group by stat key, sorted by count desc
    const byStat = new Map()
    for (const d of diffs) { if (!byStat.has(d.key)) byStat.set(d.key, []); byStat.get(d.key).push(d) }
    const sorted = [...byStat.entries()].sort((a, b) => b[1].length - a[1].length)
    if (diffs.length) {
        console.log('\n=== UNEXPECTED DIFFERENCES (ours vs pyfa) ===')
        for (const [key, list] of sorted) {
            console.log(`\n● ${key}  (${list.length} fit${list.length > 1 ? 's' : ''})`)
            list.sort((a, b) => Math.abs(b.pctDelta ?? 0) - Math.abs(a.pctDelta ?? 0))
            for (const d of list.slice(0, 12)) {
                const pct = d.pctDelta == null ? '' : `  (${d.pctDelta > 0 ? '+' : ''}${d.pctDelta.toFixed(1)}%)`
                console.log(`    ${String(d.ship).padEnd(22)} ${d.fitType.padEnd(12)} ours=${fmt(d.ours).padStart(12)} pyfa=${fmt(d.pyfa).padStart(12)}${pct}`)
            }
            if (list.length > 12) console.log(`    … +${list.length - 12} more`)
        }
    }
    console.log(`\nSummary: ${summary.okFits}/${summary.total} fits match | ${diffs.length} unexpected diff${diffs.length === 1 ? '' : 's'}` +
        ` across ${byStat.size} stats | ${accepted.length} accepted | our-fail ${summary.ourFail} | oracle-fail ${summary.oracleFail}` +
        ` | oracle-skipped ${summary.oracleSkipped ?? 0}`)
    if (drift.length) {
        console.log(`⚠️  Oracle SDE drift — the pin is stale (see above). Engine parity was NOT assessed on ${summary.oracleSkipped} fit(s).`)
    }
    if (!diffs.length && !drift.length) {
        // A green tick on an EMPTY or shrunken corpus is the lie this harness
        // exists to prevent, so say what was actually compared. `0/0 fits match`
        // is not a pass.
        const caveats = summary.corpusNotes ?? []
        if (summary.total === 0) {
            console.log(`⚠️  Nothing was compared — 0 fits in the corpus. This is NOT a pass.`)
        } else if (caveats.length) {
            console.log(`✅ No unexpected differences across the ${summary.total} fits compared` +
                `${accepted.length ? ` (${accepted.length} documented quirk${accepted.length === 1 ? '' : 's'} accepted)` : ''}` +
                ` — but the corpus is INCOMPLETE, see the note${caveats.length === 1 ? '' : 's'} above.`)
        } else {
            console.log(`✅ No unexpected differences — engine matches pyfa across all ${summary.total} sampled fits` +
                `${accepted.length ? ` (${accepted.length} documented pyfa float/modelling/per-ship quirks accepted; run --strict to list them as failures)` : ''}.`)
        }
    }
}

main().catch(e => { console.error(e); process.exit(2) })
