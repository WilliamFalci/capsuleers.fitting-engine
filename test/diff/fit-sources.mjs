/**
 * Fit SOURCES for the differential parity harness.
 *
 * The harness diffs our engine against pyfa on a corpus of fits; this module is
 * where a corpus comes from. Three of them, each answering a question the others
 * can't:
 *
 *   generated  (fit-generator.mjs) — 4 synthetic fits for EVERY published ship.
 *              Complete hull coverage, but built by OUR OWN slot/charge
 *              predicates, so it only exercises what we already believe fits.
 *
 *   workbench  — 2-3 REAL fits per hull, published by capsuleers on EVE
 *              Workbench (.workbench/corpus.json, `npm run corpus:fetch`).
 *              Covers combinations no generator proposes: officer/deadspace
 *              mixes, ancillary reps, triple-web tackle, cap chains, links.
 *              Incomplete by nature — only hulls people actually publish.
 *
 *   implants   — implant SETS and BOOSTERS, which neither of the other two
 *              carries at all (Workbench EFTs list boosters as cargo, and the
 *              generator never touches the character side). This is the corpus
 *              that exercises attr-802 set multipliers and booster side effects.
 *
 * Every source emits the SAME engine-agnostic spec, so run-diff feeds both
 * engines identical input and any difference is engine math:
 *
 *   { shipTypeID, fitType, modules[], drones[], fighters[], subsystems[],
 *     implants[], boosters[], modeTypeID? }
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseEft, BOOSTER_SIDE_EFFECT_IDS } from '../../dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../../.workbench/corpus.json')

const attrV = (t, id) => t?.attributes?.find?.(a => a.id === id)?.v
const ATTR_DRONE_BANDWIDTH_USED = 1272
const ATTR_VOLUME = 283
const ATTR_IMPLANT_SLOT = 331
const ATTR_BOOSTER_SLOT = 1087
const BOOSTER_GROUP = 303

// ---------------------------------------------------------------------------
// Workbench: real published fits
// ---------------------------------------------------------------------------

/**
 * Drones come out of an EFT as a BAY listing with no active count, and the two
 * engines must not be left to clamp it differently — pyfa trusts `amountActive`
 * verbatim while ours re-derives from bandwidth. So the active count is decided
 * HERE, once, from bay volume and bandwidth, and both sides are handed the same
 * number. Anything left over stays in the bay as the author intended.
 */
function resolveDroneCounts(dataset, drones, caps) {
    let bayLeft = caps.droneBayMax ?? 0
    let bwLeft = caps.droneBandwidthMax ?? 0
    const out = []
    for (const d of drones) {
        const t = dataset.typesByBucket.drones?.get(d.typeID)
        if (!t) continue
        const vol = t.volume ?? attrV(t, ATTR_VOLUME) ?? 5
        const bw = attrV(t, ATTR_DRONE_BANDWIDTH_USED) ?? vol
        const total = Math.max(1, d.countTotal ?? 1)
        const byBay = vol > 0 ? Math.floor(bayLeft / vol) : total
        const byBw = bw > 0 ? Math.floor(bwLeft / bw) : total
        const active = Math.max(0, Math.min(total, byBay, byBw))
        out.push({ typeID: d.typeID, count: total, active })
        bayLeft -= vol * Math.min(total, byBay)
        bwLeft -= bw * active
    }
    return out
}

/**
 * Read the harvested corpus and turn each EFT into a spec.
 *
 * A fit whose EFT we cannot parse is REPORTED, never silently dropped: a
 * shrinking corpus that still prints "no differences" is the failure mode this
 * whole harness exists to avoid (see the oracle-drift note in run-diff).
 */
export function loadWorkbenchFits(dataset, computeFit, skillProfile, { perHull = 3 } = {}) {
    if (!existsSync(CORPUS)) {
        return { fits: [], failures: [], missing: true }
    }
    const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'))
    const fits = []
    const failures = []
    const seenPerHull = new Map()

    for (const row of corpus) {
        const n = seenPerHull.get(row.shipTypeID) ?? 0
        if (n >= perHull) continue

        let parsed
        try {
            parsed = parseEft(row.eft, dataset)
        } catch (e) {
            failures.push({ id: row.id, ship: row.shipName, reason: e.message })
            continue
        }
        const fit = parsed.fit ?? parsed
        const ship = dataset.typesByBucket.ships?.get(fit.shipTypeID)
        if (!ship) {
            failures.push({ id: row.id, ship: row.shipName, reason: `ship ${fit.shipTypeID} not in bundle` })
            continue
        }

        // Resolve the hull's real drone caps through our own engine, exactly as
        // the generated source does — a T3C's caps depend on its subsystems.
        let caps = {}
        try {
            const base = {
                shipTypeID: fit.shipTypeID, name: 'base', visibility: 'PRIVATE', tags: [],
                modules: [], drones: [], fighters: [], cargo: [], implants: [], boosters: [],
                subsystems: fit.subsystems ?? [],
            }
            caps = computeFit(base, dataset, { skillProfile }).derived.fitting
        } catch { /* caps stay empty → no drones counted active */ }

        seenPerHull.set(row.shipTypeID, n + 1)
        fits.push({
            shipTypeID: fit.shipTypeID,
            fitType: `wb${n + 1}`,
            label: row.name,
            modules: (fit.modules ?? []).map((m, i) => ({
                id: `m${i}`, position: i, slotType: m.slotType,
                typeID: m.typeID, state: m.state, chargeTypeID: m.chargeTypeID,
            })),
            drones: resolveDroneCounts(dataset, fit.drones ?? [], caps),
            fighters: (fit.fighters ?? []).map(f => ({ typeID: f.typeID, count: f.count })),
            subsystems: (fit.subsystems ?? []).map(s => ({ typeID: s.typeID })),
            implants: (fit.implants ?? []).map(im => ({ typeID: im.typeID, slot: im.slot })),
            boosters: (fit.boosters ?? []).map(b => ({ typeID: b.typeID, slot: b.slot, activeSideEffects: [] })),
            modeTypeID: fit.modeTypeID,
        })
    }
    return { fits, failures, missing: false }
}

// ---------------------------------------------------------------------------
// Implants + boosters
// ---------------------------------------------------------------------------

/**
 * Implant SETS are the interesting case, and they are a mechanic rather than a
 * list of items: every member of a set carries attr 802 (the set multiplier)
 * plus a `setBonus*` effect that multiplies the bonus attribute on every OTHER
 * member of its group, itself included. Wearing five plus the Omega is worth far
 * more than the sum of six — a full Low-grade Snake set is +10.5% velocity where
 * the six bonuses add to 3.75% — so a corpus of single implants would never see
 * the mechanic, let alone a bug in it.
 *
 * Sets are discovered from the data, not hardcoded: implants whose name is
 * "<grade> <Family> <Greek letter>", grouped by family, one member per slot.
 */
function discoverImplantSets(dataset) {
    const implants = [...(dataset.typesByBucket.implants?.values() ?? [])]
        .filter(t => t.published !== false && t.groupID !== BOOSTER_GROUP)
    const byFamily = new Map()
    for (const t of implants) {
        const m = /^((?:Low-grade|Mid-grade|High-grade)\s+\S+)\s+(?:Alpha|Beta|Gamma|Delta|Epsilon|Omega)$/.exec(t.name ?? '')
        if (!m) continue
        const fam = m[1]
        if (!byFamily.has(fam)) byFamily.set(fam, [])
        byFamily.get(fam).push(t)
    }
    const sets = []
    for (const [fam, list] of byFamily) {
        const bySlot = new Map()
        for (const t of list) {
            const slot = attrV(t, ATTR_IMPLANT_SLOT)
            if (slot != null && !bySlot.has(slot)) bySlot.set(slot, t)
        }
        if (bySlot.size >= 2) {
            sets.push({
                name: fam,
                members: [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
            })
        }
    }
    sets.sort((a, b) => a.name.localeCompare(b.name))
    return sets
}

/** Hardwiring implants (the non-set ones), grouped by slot. */
function hardwiringsBySlot(dataset) {
    const bySlot = new Map()
    for (const t of (dataset.typesByBucket.implants?.values() ?? [])) {
        if (t.published === false || t.groupID === BOOSTER_GROUP) continue
        if (/(Low|Mid|High)-grade/.test(t.name ?? '')) continue
        const slot = attrV(t, ATTR_IMPLANT_SLOT)
        if (slot == null) continue
        if (!bySlot.has(slot)) bySlot.set(slot, [])
        bySlot.get(slot).push(t)
    }
    for (const list of bySlot.values()) list.sort((a, b) => a.id - b.id)
    return bySlot
}

/**
 * Boosters worth comparing.
 *
 * Of 453 published boosters only a minority touch a ship at all: the rest are
 * cerebral accelerators, season passes and insurance, which move CHARACTER
 * attributes (skill training) and would contribute nothing but noise — several
 * of them are also Serenity/Tiamat items the pinned pyfa staticdata has never
 * heard of, and each one of those turns a comparable fit into a skipped one.
 *
 * The filter is therefore data-driven rather than a name blocklist: keep a
 * booster if any of its effects modifies the SHIP. That is exactly the 24
 * combat boosters (8 families × 3 grades) plus the handful of ship-affecting
 * speciality ones, and every one of them exists on both sides.
 */
function shipAffectingBoosters(dataset) {
    const out = []
    for (const t of (dataset.typesByBucket.implants?.values() ?? [])) {
        if (t.published === false || t.groupID !== BOOSTER_GROUP) continue
        const touchesShip = (t.effects ?? []).some(e => {
            const eff = dataset.effects.get(e.id ?? e)
            return (eff?.modifierInfo ?? []).some(mi => mi.domain === 'shipID')
        })
        if (touchesShip) out.push(t)
    }
    out.sort((a, b) => a.id - b.id)
    return out
}

/** The side effects a booster type declares — see sideEffectIds note below. */
function sideEffectIds(boosterType) {
    return (boosterType.effects ?? [])
        .map(e => e.id ?? e)
        .filter(id => BOOSTER_SIDE_EFFECT_IDS.has(id))
}

/** One fit per implant set. */
const setFit = (ship, set) => ({
    shipTypeID: ship.id,
    fitType: `set:${set.name.replace(/\s+/g, '-')}`,
    modules: [], drones: [], fighters: [], subsystems: [], boosters: [],
    implants: set.members.map(t => ({ typeID: t.id, slot: attrV(t, ATTR_IMPLANT_SLOT) })),
})

/** A booster, drawbacks off and drawbacks on — the pair isolates the opt-in
 *  path from the bonus itself, since both engines default them off. */
function boosterFits(ship, booster) {
    const slot = attrV(booster, ATTR_BOOSTER_SLOT) ?? 1
    const tag = (booster.name ?? String(booster.id)).replace(/\s+/g, '-')
    const side = sideEffectIds(booster)
    const fits = [{
        shipTypeID: ship.id, fitType: `boost:${tag}`,
        modules: [], drones: [], fighters: [], subsystems: [], implants: [],
        boosters: [{ typeID: booster.id, slot, activeSideEffects: [] }],
    }]
    if (side.length) {
        fits.push({
            shipTypeID: ship.id, fitType: `boost:${tag}:side`,
            modules: [], drones: [], fighters: [], subsystems: [], implants: [],
            boosters: [{ typeID: booster.id, slot, activeSideEffects: side }],
        })
    }
    return fits
}

/** A full hardwiring rack, one per slot: plain ItemModifier bonuses whose only
 *  interesting question is whether they penalise each other (they must not). */
function hardwiringFit(ship, bySlot) {
    const rack = []
    for (const slot of [6, 7, 8, 9, 10]) {
        const list = bySlot.get(slot)
        if (list?.length) rack.push({ typeID: list[Math.floor(list.length / 2)].id, slot })
    }
    if (!rack.length) return []
    return [{
        shipTypeID: ship.id, fitType: 'hardwirings',
        modules: [], drones: [], fighters: [], subsystems: [], boosters: [],
        implants: rack,
    }]
}

/**
 * The FULL implant/booster matrix on one hull: every set, every ship-affecting
 * booster with its drawbacks off and on, plus the hardwiring rack. This is what
 * guarantees each of the 55 sets and each booster is compared at least once.
 *
 * The hull is deliberately BARE: an implant set's whole job is to move a ship
 * attribute, and burying it under forty modules would let a stacking bug hide
 * inside a rounding difference. What is under test here is the character side.
 */
export function generateImplantMatrix(dataset, ship) {
    const out = []
    for (const set of discoverImplantSets(dataset)) out.push(setFit(ship, set))
    out.push(...hardwiringFit(ship, hardwiringsBySlot(dataset)))
    for (const b of shipAffectingBoosters(dataset)) out.push(...boosterFits(ship, b))
    return out
}

/**
 * A deterministic SLICE of that matrix for one hull.
 *
 * Running 55 sets × 24 boosters against every published hull would be a
 * cartesian product for no extra signal — these bonuses move ship attributes
 * and barely care which hull they land on. Rotating by hull index instead
 * spreads the whole catalogue across the ship list, so every set and every
 * booster still meets many different hulls (and any hull-specific interaction
 * has a chance to surface) at a fraction of the cost.
 */
export function generateImplantFits(dataset, ship, rotation = 0) {
    const sets = discoverImplantSets(dataset)
    const boosters = shipAffectingBoosters(dataset)
    const out = []
    if (sets.length) {
        out.push(setFit(ship, sets[rotation % sets.length]))
        out.push(setFit(ship, sets[(rotation * 7 + 3) % sets.length]))
    }
    out.push(...hardwiringFit(ship, hardwiringsBySlot(dataset)))
    if (boosters.length) out.push(...boosterFits(ship, boosters[rotation % boosters.length]))
    return out
}
