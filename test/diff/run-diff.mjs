/**
 * Differential Pyfa-parity harness.
 *
 * For every ship, generate 4 fits (fit-generator), compute each with OUR engine
 * and with pyfa-org/Pyfa (oracle/pyfa_oracle.py via the .pyfa venv), diff the
 * stats (stat-schema), and print every difference. Exit 1 if any difference is
 * found beyond tolerance — so it can drive a /goal verify-and-fix loop.
 *
 *   npm run diff                       # all ships
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
import { loadBundledDataset } from '../../dist/node.js'
import { computeFit } from '../../dist/index.js'
import { generateFits } from './fit-generator.mjs'
import { oursToSchema, flatten, diffStats } from './stat-schema.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PYFA = resolve(HERE, '../../.pyfa')
const ALLV = { name: 'All V', isDefault: true, source: 'preset', skills: {} }

function parseArgs(argv) {
    const a = { tol: 0.01, eps: 0.01 }
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
    modules: spec.modules, fighters: [], cargo: [], implants: [], boosters: [],
    drones: spec.drones.map((d, i) => ({ id: `d${i}`, typeID: d.typeID, countTotal: d.count, countActive: d.active })),
    subsystems: spec.subsystems.map((s, i) => ({ id: `s${i}`, slot: i + 1, typeID: s.typeID })),
})
const toOracleSpec = (spec, id) => ({
    id, shipTypeID: spec.shipTypeID,
    modules: spec.modules.map(m => ({ typeID: m.typeID, state: m.state, chargeTypeID: m.chargeTypeID })),
    drones: spec.drones, subsystems: spec.subsystems,
})

function runOracle(specs) {
    const py = resolve(PYFA, '.venv/bin/python')
    const res = spawnSync(py, [resolve(HERE, '../../oracle/pyfa_oracle.py')], {
        cwd: PYFA,
        env: { ...process.env, PYTHONPATH: `${PYFA}:${resolve(PYFA, '_oracle_stubs')}` },
        input: JSON.stringify(specs), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
    })
    if (res.status !== 0) {
        console.error('[oracle] failed:', res.stderr?.slice(-2000))
        process.exit(2)
    }
    const out = JSON.parse(res.stdout)
    return new Map(out.map(r => [r.id, r]))
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!existsSync(resolve(PYFA, 'eve.db'))) {
        console.error('Oracle not set up. Run: npm run diff:setup'); process.exit(2)
    }
    const dataset = await loadBundledDataset()
    const ships = resolveShips(dataset, args)
    console.error(`[diff] ${ships.length} ships × 4 fits, tol=${args.tol}`)

    // Generate + our compute; collect oracle specs.
    const items = []   // { id, ship, fitType, oursFlat }
    const oracleSpecs = []
    for (const ship of ships) {
        let fits
        try { fits = generateFits(dataset, ship, computeFit) } catch (e) { console.error(`[gen] ${ship.name}: ${e.message}`); continue }
        for (const spec of fits) {
            if (args.only && !args.only.includes(spec.fitType)) continue
            const id = `${ship.id}:${spec.fitType}`
            let oursFlat = null
            try {
                const c = computeFit(toOurFit(spec), dataset, { skillProfile: ALLV })
                oursFlat = flatten(oursToSchema(c.derived))
            } catch (e) { oursFlat = { __error: e.message } }
            items.push({ id, ship, fitType: spec.fitType, oursFlat })
            oracleSpecs.push(toOracleSpec(spec, id))
        }
    }

    console.error(`[diff] running oracle on ${oracleSpecs.length} fits...`)
    const oracle = runOracle(oracleSpecs)

    // Diff.
    const allDiffs = []   // { ship, fitType, key, ours, pyfa, pctDelta }
    let okFits = 0, oracleFail = 0, ourFail = 0
    for (const it of items) {
        const o = oracle.get(it.id)
        if (it.oursFlat.__error) { ourFail++; continue }
        if (!o || !o.ok) { oracleFail++; continue }
        let pyfaFlat = flatten(o.stats)
        if (args.stats) {
            const keep = (k) => args.stats.some(g => k.startsWith(g))
            pyfaFlat = Object.fromEntries(Object.entries(pyfaFlat).filter(([k]) => keep(k)))
        }
        const diffs = diffStats(it.oursFlat, pyfaFlat, { tol: args.tol, eps: args.eps })
        if (!diffs.length) okFits++
        for (const d of diffs) allDiffs.push({ ship: it.ship.name, shipId: it.ship.id, fitType: it.fitType, ...d })
    }

    report(allDiffs, { total: items.length, okFits, oracleFail, ourFail }, args)
    process.exit(allDiffs.length ? 1 : 0)
}

function report(diffs, summary, args) {
    if (args.json) { console.log(JSON.stringify({ summary, diffs }, null, 2)); return }
    const fmt = (v) => v == null ? '—' : (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v))
    // group by stat key, sorted by count desc
    const byStat = new Map()
    for (const d of diffs) { if (!byStat.has(d.key)) byStat.set(d.key, []); byStat.get(d.key).push(d) }
    const sorted = [...byStat.entries()].sort((a, b) => b[1].length - a[1].length)
    console.log('\n=== DIFFERENCES (ours vs pyfa) ===')
    for (const [key, list] of sorted) {
        console.log(`\n● ${key}  (${list.length} fit${list.length > 1 ? 's' : ''})`)
        list.sort((a, b) => Math.abs(b.pctDelta ?? 0) - Math.abs(a.pctDelta ?? 0))
        for (const d of list.slice(0, 12)) {
            const pct = d.pctDelta == null ? '' : `  (${d.pctDelta > 0 ? '+' : ''}${d.pctDelta.toFixed(1)}%)`
            console.log(`    ${String(d.ship).padEnd(22)} ${d.fitType.padEnd(12)} ours=${fmt(d.ours).padStart(12)} pyfa=${fmt(d.pyfa).padStart(12)}${pct}`)
        }
        if (list.length > 12) console.log(`    … +${list.length - 12} more`)
    }
    console.log(`\nSummary: ${summary.okFits}/${summary.total} fits match | ${diffs.length} stat diffs across ${byStat.size} stats` +
        ` | our-fail ${summary.ourFail} | oracle-fail ${summary.oracleFail}`)
    if (!diffs.length) console.log('✅ No differences — engine matches pyfa across all sampled fits.')
}

main().catch(e => { console.error(e); process.exit(2) })
