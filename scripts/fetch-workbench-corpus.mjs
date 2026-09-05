/**
 * Harvest a REAL-fit corpus from EVE Workbench for the differential parity
 * harness (test/diff --source=workbench).
 *
 * The generated 4-fits-per-ship corpus (test/diff/fit-generator.mjs) is built by
 * OUR OWN slot/charge predicates, so it exercises what we already believe is
 * fittable. Fits humans actually publish exercise combinations no generator
 * proposes: officer/deadspace mixes, ancillary reps, command bursts, links,
 * triple-web setups, cap chains — plus module pairings whose stacking or
 * legacy-handler interaction is exactly where an engine drifts from pyfa.
 *
 * Two upstream facts (measured, and unchanged since 2026-08-07):
 *   1. `/v1/fits/public` takes ONLY `page` — every filter is ignored, so the
 *      index is built by walking pages and bucketing by ShipId on our side.
 *   2. It advertises ~382 pages but only serves the first ~60; page 61+ hangs
 *      (300 s+, not a timeout we're too impatient for). MAX_PAGE encodes that.
 *
 * Their API rate-limits on BURST, not on rate: 5 964 requests at concurrency 6
 * earned 429s, while 400 sequential at ~11.6/s drew none. EFT fetches therefore
 * run at concurrency 2 — deliberately slow; the corpus is cached and this is a
 * one-off. A 429 aborts the pass rather than hammering through it.
 *
 * Output: .workbench/corpus.json (gitignored — these are other capsuleers'
 * published fits; we read them like the site does, we don't redistribute them).
 *
 *   npm run corpus:fetch                 # default 3 fits/hull
 *   npm run corpus:fetch -- --per=2      # fewer
 *   npm run corpus:fetch -- --pages=20   # shallower index walk
 *   npm run corpus:fetch -- --refresh    # ignore the cached index
 *
 * Needs an API key: EVEWORKBENCH_API_KEY (or NUXT_EVEWORKBENCH_API_KEY).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.workbench')
const INDEX_FILE = path.join(CACHE, 'index.json')
const CORPUS_FILE = path.join(CACHE, 'corpus.json')

const BASE = 'https://api.eveworkbench.com'
const UA = 'Capsuleers.App/1.0 (+https://capsuleers.app; info@capsuleers.app)'
/** Last page the upstream actually serves — see header note (2). */
const MAX_PAGE = 60
const LIST_CONCURRENCY = 4
/** Burst-limited upstream: keep this at 2. See header. */
const EFT_CONCURRENCY = 2

const KEY = process.env.EVEWORKBENCH_API_KEY || process.env.NUXT_EVEWORKBENCH_API_KEY
if (!KEY) { console.error('[corpus] set EVEWORKBENCH_API_KEY'); process.exit(1) }

function parseArgs(argv) {
    const a = { per: 3, pages: MAX_PAGE, refresh: false }
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); if (!m) continue
        const [, k, v] = m
        if (k === 'per') a.per = Number(v)
        else if (k === 'pages') a.pages = Math.min(Number(v), MAX_PAGE)
        else if (k === 'refresh') a.refresh = true
    }
    return a
}

class RateLimited extends Error {}

async function wb(pathname, timeoutMs = 30_000) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
        const r = await fetch(`${BASE}${pathname}`, {
            headers: { 'X-API-KEY': KEY, 'User-Agent': UA },
            signal: ctl.signal,
        })
        if (r.status === 429) throw new RateLimited('429 from upstream')
        if (!r.ok) throw new Error(`${pathname} -> ${r.status}`)
        return await r.json()
    } finally { clearTimeout(t) }
}

/** Bounded-concurrency map that preserves order and surfaces the first 429. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length)
    let i = 0, fatal = null
    const worker = async () => {
        for (;;) {
            const idx = i++
            if (idx >= items.length || fatal) return
            try { out[idx] = await fn(items[idx], idx) }
            catch (e) { if (e instanceof RateLimited) fatal = e; out[idx] = { __error: e.message } }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    if (fatal) throw fatal
    return out
}

/** Walk the public list and return every fit row it serves. */
async function buildIndex(pages) {
    const first = await wb('/v1/fits/public?page=1')
    const total = Math.min(first.NumberOfPages ?? 1, pages)
    console.error(`[corpus] upstream declares ${first.NumberOfPages} pages / ${first.TotalFits} fits; walking ${total}`)
    const rest = Array.from({ length: total - 1 }, (_, i) => i + 2)
    const rows = [...(first.Fits ?? [])]
    let done = 1
    const pagesOut = await mapLimit(rest, LIST_CONCURRENCY, async (p) => {
        const j = await wb(`/v1/fits/public?page=${p}`)
        done++
        if (done % 10 === 0) console.error(`[corpus]   ${done}/${total} pages`)
        return j.Fits ?? []
    })
    for (const p of pagesOut) if (Array.isArray(p)) rows.push(...p)
    return rows
}

/**
 * Pick up to `per` fits per hull, spread across the hull's own list rather than
 * taking the top N: the list is newest-first, and three fits published the same
 * week by the same meta are three copies of one fit. Deterministic (index
 * arithmetic, no RNG) so a re-run reproduces the same corpus.
 */
function pickPerHull(rows, per) {
    const byShip = new Map()
    for (const f of rows) {
        if (!f?.Id || !f.ShipId) continue
        if (!byShip.has(f.ShipId)) byShip.set(f.ShipId, [])
        byShip.get(f.ShipId).push(f)
    }
    const picked = []
    for (const [shipId, list] of byShip) {
        list.sort((a, b) => String(a.Id).localeCompare(String(b.Id)))   // stable, order-independent
        const n = Math.min(per, list.length)
        for (let i = 0; i < n; i++) {
            const f = list[Math.floor(i * list.length / n)]
            picked.push({ id: f.Id, shipTypeID: shipId, shipName: f.ShipName, name: f.Name, dps: f.TotalDps ?? 0 })
        }
    }
    picked.sort((a, b) => a.shipTypeID - b.shipTypeID || a.id.localeCompare(b.id))
    return picked
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    await mkdir(CACHE, { recursive: true })

    let rows
    if (!args.refresh && existsSync(INDEX_FILE)) {
        rows = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
        console.error(`[corpus] reusing cached index (${rows.length} rows) — --refresh to re-walk`)
    } else {
        rows = await buildIndex(args.pages)
        await writeFile(INDEX_FILE, JSON.stringify(rows))
        console.error(`[corpus] indexed ${rows.length} fits`)
    }

    const picked = pickPerHull(rows, args.per)
    const hulls = new Set(picked.map(p => p.shipTypeID)).size
    console.error(`[corpus] ${picked.length} fits across ${hulls} hulls — fetching EFT at concurrency ${EFT_CONCURRENCY}`)

    // Reuse EFTs already fetched: the pass is slow on purpose and a 429 must not
    // cost the work already paid for.
    const have = existsSync(CORPUS_FILE) ? JSON.parse(await readFile(CORPUS_FILE, 'utf8')) : []
    const known = new Map(have.map(f => [f.id, f]))
    const todo = picked.filter(p => !known.has(p.id))
    console.error(`[corpus] ${known.size} cached, ${todo.length} to fetch`)

    let n = 0, failed = 0
    try {
        const fetched = await mapLimit(todo, EFT_CONCURRENCY, async (p) => {
            const j = await wb(`/v1/fits/${encodeURIComponent(p.id)}/eft`, 20_000)
            n++
            if (n % 50 === 0) console.error(`[corpus]   ${n}/${todo.length} EFTs`)
            const eft = j?.Eft?.trim()
            if (!eft) throw new Error('empty EFT')
            return { ...p, eft }
        })
        for (const f of fetched) { if (f?.eft) known.set(f.id, f); else failed++ }
    } catch (e) {
        console.error(`[corpus] aborted: ${e.message} — writing what we have`)
    }

    const corpus = [...known.values()].sort((a, b) => a.shipTypeID - b.shipTypeID || a.id.localeCompare(b.id))
    await writeFile(CORPUS_FILE, JSON.stringify(corpus, null, 0))
    const gotHulls = new Set(corpus.map(f => f.shipTypeID)).size
    console.error(`[corpus] wrote ${corpus.length} fits across ${gotHulls} hulls → ${path.relative(ROOT, CORPUS_FILE)}${failed ? ` (${failed} failed)` : ''}`)
}

main().catch(e => { console.error('[corpus]', e); process.exit(1) })
