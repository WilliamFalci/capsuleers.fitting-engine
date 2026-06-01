/**
 * Deterministic 4-fits-per-ship generator for the differential parity harness.
 *
 * For each ship it produces:
 *   - bonused      : weapons of the ship's primary hardpoint system + matching mods
 *   - non-bonused  : a different weapon system / off-bonus modules
 *   - t2           : every slot filled with T2 (metaGroup 2) modules
 *   - mixed        : weapons + a spread of T1/T2/faction/deadspace/officer mods
 *
 * Slot/hardpoint/drone capacities are read from OUR engine (computeFit on a base
 * ship+subsystems fit) so it works uniformly for normal hulls AND T3Cs. Fits are
 * best-effort and may over/under-fill — both engines compute the same thing, and
 * the diff is what matters. RNG is seeded by shipTypeID for reproducibility.
 *
 * A fit-spec is engine-agnostic: { shipTypeID, fitType, modules, drones, subsystems }.
 */
import { typeFitsSlotType, isTurretWeapon, isMissileLauncher, canFitModuleOnShip, defaultStateForModule, chargeGroupsForModule, moduleAcceptsAnyCharge } from '../../dist/index.js'

const META = { T1: 1, T2: 2, STORYLINE: 3, FACTION: 4, OFFICER: 5, DEADSPACE: 6 }
const SLOTS = ['HI', 'MED', 'LO', 'RIG']
const STRATEGIC_CRUISER_GROUP = 963
const SUBSYSTEM_GROUPS = [954, 955, 956, 957, 958] // defensive/electronic/offensive/propulsion/core

const attrV = (t, id) => t.attributes?.find?.(a => a.id === id)?.v
/** Reject size-inappropriate modules: a rig whose rigSize != the ship's, or any
 *  module that alone exceeds the ship's CPU or PG output (Capital-on-frigate
 *  etc.). Over-fitting across MANY modules is fine; a single oversized one is not. */
function sizeOk(t, ship, cpuMax, pgMax) {
    const rs = attrV(t, 1547)            // rigSize
    if (rs != null && attrV(ship, 1547) != null && rs !== attrV(ship, 1547)) return false
    const cpu = attrV(t, 50), pg = attrV(t, 30)
    if (cpu != null && cpuMax && cpu > cpuMax) return false
    if (pg != null && pgMax && pg > pgMax) return false
    return true
}

// deterministic PRNG (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const pick = (arr, r) => (arr.length ? arr[Math.floor(r() * arr.length)] : null)
const metaOf = (t) => t.metaGroupID ?? 1

let POOL = null
/** One-time global module index by slot + weapon kind + metaGroup. */
function buildPool(dataset) {
    if (POOL) return POOL
    const all = [...(dataset.typesByBucket.modules?.values() ?? [])].filter(t => t.published !== false)
    const bySlot = { HI: [], MED: [], LO: [], RIG: [] }
    for (const t of all) for (const s of SLOTS) if (typeFitsSlotType(t, s)) bySlot[s].push(t)
    // Exclude Polarized weapons as primary armament — they zero all resists
    // (a niche edge case) and aren't representative of a normal fit.
    const normal = (t) => !/Polarized/i.test(t.name ?? '')
    const turrets = bySlot.HI.filter(t => isTurretWeapon(t) && normal(t))
    const launchers = bySlot.HI.filter(t => isMissileLauncher(t) && normal(t))
    const charges = [...(dataset.typesByBucket.charges?.values() ?? [])].filter(t => t.published !== false)
    POOL = { bySlot, turrets, launchers, charges }
    return POOL
}

function chargeFor(dataset, mod, r) {
    if (!moduleAcceptsAnyCharge(mod)) return undefined
    const groups = new Set(chargeGroupsForModule(mod))
    const cands = POOL.charges.filter(c => groups.has(c.groupID))
    const c = pick(cands, r)
    return c?.id
}

function weaponList(pool, kind) { return kind === 'launcher' ? pool.launchers : pool.turrets }

/** Pick a weapon set for the ship's hardpoints, preferring metaGroup `meta`. */
function fillWeapons(dataset, ship, pool, kind, count, meta, r, cpuMax, pgMax) {
    if (count <= 0) return []
    const list = weaponList(pool, kind).filter(t => canFitModuleOnShip(ship, t, dataset) && sizeOk(t, ship, cpuMax, pgMax))
    const preferred = list.filter(t => metaOf(t) === meta)
    const base = (preferred.length ? preferred : list)
    // group by groupID, pick one group deterministically, use its biggest-meta member
    if (!base.length) return []
    const w = pick(base, r)
    const out = []
    for (let i = 0; i < count; i++) {
        const state = defaultStateForModule(w, dataset.effects)
        out.push({ typeID: w.id, slotType: 'HI', state, chargeTypeID: chargeFor(dataset, w, r) })
    }
    return out
}

function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }

function fillSlot(dataset, ship, pool, slot, count, metaPickers, r, cpuMax, pgMax) {
    if (count <= 0) return []
    let list = pool.bySlot[slot].filter(t => canFitModuleOnShip(ship, t, dataset) && sizeOk(t, ship, cpuMax, pgMax))
    // Leftover HIGH slots are utility (neuts/nos/smartbombs/etc.) — never fill
    // them with weapons (those go on hardpoints) or hardpoint-less weapon junk.
    if (slot === 'HI') list = list.filter(t => !isTurretWeapon(t) && !isMissileLauncher(t))
    const out = []
    const usedGroups = new Map() // groupID -> times used (cap duplicates of stacking-penalized mods)
    // distinct picks: cycle through a shuffled candidate list so we don't stack
    // 5 identical hardeners (unrealistic + triggers edge cases / sentinels).
    for (let i = 0; i < count; i++) {
        const meta = metaPickers(i)
        let cands = shuffle(list.filter(t => metaOf(t) === meta), r)
        if (!cands.length) cands = shuffle(list, r)
        // prefer a module from a group we haven't filled twice already
        const m = cands.find(t => (usedGroups.get(t.groupID) ?? 0) < 2) ?? cands[0]
        if (!m) break
        usedGroups.set(m.groupID, (usedGroups.get(m.groupID) ?? 0) + 1)
        out.push({ typeID: m.id, slotType: slot, state: defaultStateForModule(m, dataset.effects), chargeTypeID: chargeFor(dataset, m, r) })
    }
    return out
}

function droneSet(dataset, bayMax, bwMax, r) {
    if (!bayMax || bayMax <= 0) return []
    // Pick a drone that actually fits the bandwidth, and set an active count that
    // is valid for BOTH bay and bandwidth so neither engine clamps differently.
    const drones = shuffle([...(dataset.typesByBucket.drones?.values() ?? [])].filter(t => t.published !== false), r)
    for (const d of drones) {
        const vol = d.volume ?? d.attributes?.find?.(a => a.id === 283)?.v ?? 5
        const bw = d.attributes?.find?.(a => a.id === 1271)?.v ?? vol
        if (!vol || !bw || bw > bwMax) continue
        const byBay = Math.floor(bayMax / vol)
        const byBw = Math.floor(bwMax / bw)
        const n = Math.max(1, Math.min(5, byBay, byBw))
        if (n >= 1) return [{ typeID: d.id, count: n, active: n }]
    }
    return []
}

function chooseSubsystems(dataset, ship) {
    const subs = [...(dataset.typesByBucket.subsystems?.values() ?? [])].filter(t => t.published !== false)
    const out = []
    for (const g of SUBSYSTEM_GROUPS) {
        // subsystem belongs to parent ship via attr 1380 (fitsToShipType-ish) — match by parent ship
        const forShip = subs.filter(t => t.groupID === g && (t.attributes?.find?.(a => a.id === 1380)?.v === ship.id))
        if (forShip.length) out.push({ typeID: forShip[0].id })
    }
    return out
}

/** Generate the 4 fit-specs for a ship. `computeFit` is used to resolve slots. */
export function generateFits(dataset, ship, computeFit) {
    const pool = buildPool(dataset)
    const isT3C = ship.groupID === STRATEGIC_CRUISER_GROUP
    const subsystems = isT3C ? chooseSubsystems(dataset, ship) : []

    // Resolve real slot/hardpoint/drone capacities via our engine (handles T3C).
    const base = { shipTypeID: ship.id, name: 'base', visibility: 'PRIVATE', tags: [], modules: [], drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: subsystems.map((s, i) => ({ id: `s${i}`, slot: i + 1, typeID: s.typeID })) }
    let cap
    try {
        const c = computeFit(base, dataset, { skillProfile: { name: 'All V', isDefault: true, source: 'preset', skills: {} } })
        cap = c.derived.fitting
    } catch { cap = null }
    const slotMax = (s) => cap?.slots?.[s]?.max ?? 0
    const turretMax = cap?.hardpoints?.turret?.max ?? 0
    const launcherMax = cap?.hardpoints?.launcher?.max ?? 0
    const bayMax = cap?.droneBayMax ?? 0, bwMax = cap?.droneBandwidthMax ?? 0

    const hi = slotMax('HI'), med = slotMax('MED'), lo = slotMax('LO'), rig = slotMax('RIG')
    const cpuMax = cap?.cpuMax ?? 0, pgMax = cap?.powerMax ?? 0
    const primaryKind = launcherMax > turretMax ? 'launcher' : 'turret'
    const otherKind = primaryKind === 'launcher' ? 'turret' : 'launcher'
    const wpCount = Math.max(turretMax, launcherMax)

    function assemble(fitType, weapons, metaForSlot) {
        const r = rng((ship.id * 31 + fitType.length * 7) >>> 0)
        const w = weapons(r)
        const usedHi = w.length
        const mods = [
            ...w,
            ...fillSlot(dataset, ship, pool, 'HI', Math.max(0, hi - usedHi), metaForSlot, r, cpuMax, pgMax),
            ...fillSlot(dataset, ship, pool, 'MED', med, metaForSlot, r, cpuMax, pgMax),
            ...fillSlot(dataset, ship, pool, 'LO', lo, metaForSlot, r, cpuMax, pgMax),
            ...fillSlot(dataset, ship, pool, 'RIG', rig, metaForSlot, r, cpuMax, pgMax),
        ].map((m, i) => ({ id: `m${i}`, position: i, ...m }))
        return { shipTypeID: ship.id, fitType, modules: mods, drones: droneSet(dataset, bayMax, bwMax, r), subsystems }
    }

    return [
        assemble('bonused',     (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.T2, r, cpuMax, pgMax), () => META.T2),
        assemble('non-bonused', (r) => fillWeapons(dataset, ship, pool, otherKind, wpCount, META.T1, r, cpuMax, pgMax), () => META.T1),
        assemble('t2',          (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.T2, r, cpuMax, pgMax), () => META.T2),
        assemble('mixed',       (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.FACTION, r, cpuMax, pgMax),
                                (i) => [META.T1, META.T2, META.FACTION, META.DEADSPACE, META.OFFICER][i % 5]),
    ]
}
