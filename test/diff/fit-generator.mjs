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
    const turrets = bySlot.HI.filter(isTurretWeapon)
    const launchers = bySlot.HI.filter(isMissileLauncher)
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
function fillWeapons(dataset, ship, pool, kind, count, meta, r) {
    if (count <= 0) return []
    const list = weaponList(pool, kind).filter(t => canFitModuleOnShip(ship, t, dataset))
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

function fillSlot(dataset, ship, pool, slot, count, metaPickers, r, exclude = new Set()) {
    if (count <= 0) return []
    const list = pool.bySlot[slot].filter(t => !exclude.has(t.id) && canFitModuleOnShip(ship, t, dataset))
    const out = []
    for (let i = 0; i < count; i++) {
        const meta = metaPickers(i)
        const cands = list.filter(t => metaOf(t) === meta)
        const m = pick(cands.length ? cands : list, r)
        if (!m) break
        out.push({ typeID: m.id, slotType: slot, state: defaultStateForModule(m, dataset.effects), chargeTypeID: chargeFor(dataset, m, r) })
    }
    return out
}

function droneSet(dataset, bayMax, bwMax, r) {
    if (!bayMax || bayMax <= 0) return []
    const drones = [...(dataset.typesByBucket.drones?.values() ?? [])].filter(t => t.published !== false)
    const d = pick(drones, r)
    if (!d) return []
    const vol = d.attributes?.find?.(a => a.id === 283)?.v ?? 5
    const n = Math.max(1, Math.min(5, Math.floor(bayMax / (vol || 5))))
    return [{ typeID: d.id, count: n, active: n }]
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
    const primaryKind = launcherMax > turretMax ? 'launcher' : 'turret'
    const otherKind = primaryKind === 'launcher' ? 'turret' : 'launcher'
    const wpCount = Math.max(turretMax, launcherMax)

    function assemble(fitType, weapons, metaForSlot) {
        const r = rng((ship.id * 31 + fitType.length * 7) >>> 0)
        const w = weapons(r)
        const usedHi = w.length
        const mods = [
            ...w,
            ...fillSlot(dataset, ship, pool, 'HI', Math.max(0, hi - usedHi), metaForSlot, r),
            ...fillSlot(dataset, ship, pool, 'MED', med, metaForSlot, r),
            ...fillSlot(dataset, ship, pool, 'LO', lo, metaForSlot, r),
            ...fillSlot(dataset, ship, pool, 'RIG', rig, metaForSlot, r),
        ].map((m, i) => ({ id: `m${i}`, position: i, ...m }))
        return { shipTypeID: ship.id, fitType, modules: mods, drones: droneSet(dataset, bayMax, bwMax, r), subsystems }
    }

    return [
        assemble('bonused',     (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.T2, r), () => META.T2),
        assemble('non-bonused', (r) => fillWeapons(dataset, ship, pool, otherKind, Math.max(turretMax, launcherMax), META.T1, r), () => META.T1),
        assemble('t2',          (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.T2, r), () => META.T2),
        assemble('mixed',       (r) => fillWeapons(dataset, ship, pool, primaryKind, wpCount, META.FACTION, r),
                                (i) => [META.T1, META.T2, META.FACTION, META.DEADSPACE, META.OFFICER][i % 5]),
    ]
}
