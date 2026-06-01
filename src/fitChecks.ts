/**
 * Fit-restriction predicates: given a candidate module + a target ship,
 * return whether the module is allowed by EVE's hard fitting rules.
 *
 * What this enforces (module won't physically fit if any check fails):
 *  - Slot type compatibility (HI / MED / LO / RIG / SUBSYSTEM / SERVICE)
 *  - canFitShipGroup1-9: module → ship group whitelist
 *  - canFitShipType1-4: module → ship type whitelist
 *  - rigSize: rig must match the ship's rig size class
 *  - Turret hardpoint count: turret weapons need ship.turretHardpoints > 0
 *  - Launcher hardpoint count: missile launchers need ship.launcherHardpoints > 0
 *  - Subsystem fitsToShipType: subsystem (categoryID 32) limited to its T3C parent
 *
 * What this does NOT enforce (these are soft warnings, not picker filters):
 *  - CPU / Power Grid availability (a fit can be over-budget temporarily)
 *  - Calibration cost (rigs)
 *  - Skill prerequisites
 *  - maxGroupFitted (only one of group X allowed) — surfaced as warning later
 *
 * Soft warnings belong on the fitted module, not on the picker.
 */

import {
    ATTR,
    CAN_FIT_SHIP_GROUP_ATTRS,
    CAN_FIT_SHIP_TYPE_ATTRS,
    CHARGE_GROUP_ATTRS,
    SLOT_EFFECT_TO_SLOT_TYPE,
    WEAPON_EFFECT_KIND,
} from './constants'
import type { SdeType, SlotType } from './types'

/** Read a numeric attribute off an SdeType (raw, before dogma chain). */
function readAttr(t: SdeType, id: number): number | undefined {
    return t.attributes.find(a => a.id === id)?.v
}

/** Does this type carry an effect that maps to the given slot type? */
export function typeFitsSlotType(t: SdeType, slot: SlotType): boolean {
    for (const e of t.effects) {
        const mapped = SLOT_EFFECT_TO_SLOT_TYPE[e.id]
        if (mapped === slot) return true
    }
    return false
}

/** True if the module is a turret weapon (laser / projectile / hybrid). */
export function isTurretWeapon(t: SdeType): boolean {
    return t.effects.some(e => WEAPON_EFFECT_KIND[e.id] === 'TURRET')
}

/** True if the module is a missile launcher (any missile launching effect). */
export function isMissileLauncher(t: SdeType): boolean {
    return t.effects.some(e => WEAPON_EFFECT_KIND[e.id] === 'MISSILE')
}

/** True if the module is a smart bomb / AoE high-slot (no hardpoint needed). */
export function isSmartBomb(t: SdeType): boolean {
    return t.effects.some(e => WEAPON_EFFECT_KIND[e.id] === 'SMARTBOMB')
}

/**
 * Collect all canFitShipGroup1-9 values declared on a module. Empty list
 * means no group restriction.
 */
export function shipGroupRestrictions(t: SdeType): number[] {
    const out: number[] = []
    for (const id of CAN_FIT_SHIP_GROUP_ATTRS) {
        const v = readAttr(t, id)
        if (v != null && v > 0) out.push(Math.round(v))
    }
    return out
}

/**
 * Collect all canFitShipType1-4 values. Empty list = no type restriction.
 */
export function shipTypeRestrictions(t: SdeType): number[] {
    const out: number[] = []
    for (const id of CAN_FIT_SHIP_TYPE_ATTRS) {
        const v = readAttr(t, id)
        if (v != null && v > 0) out.push(Math.round(v))
    }
    return out
}

/** Read `maxGroupFitted` (attr 1544) — undefined if no per-group cap. */
export function maxGroupFittedFor(mod: SdeType): number | undefined {
    const v = readAttr(mod, ATTR.MAX_GROUP_FITTED)
    return v != null && v > 0 ? Math.round(v) : undefined
}

/** Read `maxTypeFitted` (attr 2487) — undefined if no per-typeID cap. */
export function maxTypeFittedFor(mod: SdeType): number | undefined {
    const v = readAttr(mod, ATTR.MAX_TYPE_FITTED)
    return v != null && v > 0 ? Math.round(v) : undefined
}

/**
 * How many more copies of `mod` the ship can still accept under the per-
 * group / per-type fitting caps (`maxGroupFitted` / `maxTypeFitted`),
 * given the current fit. Returns `Infinity` when the module declares no
 * cap. The caller does the slot-availability arithmetic separately
 * (`freeHardpointsFor`); this only enforces the EVE-wide "max N of this
 * group/type per hull" rule.
 *
 * Example: Medium Breacher Pod Launcher has `maxGroupFitted = 1`. Even on
 * a Cenotaph with 3 launcher hardpoints, only ONE breacher launcher may
 * be fitted — the remaining hardpoints stay open for non-breacher
 * launchers (in practice the Cenotaph's `canFitShipType1` restriction on
 * the launcher means non-breacher launchers can't replace it; the cap is
 * the effective "no second breacher" rule).
 */
export function freeFitGroupSlotsFor(
    mod: SdeType,
    fittedModules: Array<{ typeID: number }>,
    dataset: { getType(id: number): SdeType | undefined },
): number {
    const groupCap = maxGroupFittedFor(mod)
    const typeCap  = maxTypeFittedFor(mod)
    if (groupCap === undefined && typeCap === undefined) return Number.POSITIVE_INFINITY

    let groupCount = 0
    let typeCount = 0
    for (const fm of fittedModules) {
        if (typeCap !== undefined && fm.typeID === mod.id) typeCount++
        if (groupCap !== undefined) {
            const t = dataset.getType(fm.typeID)
            if (t && t.groupID === mod.groupID) groupCount++
        }
    }

    let free = Number.POSITIVE_INFINITY
    if (groupCap !== undefined) free = Math.min(free, groupCap - groupCount)
    if (typeCap  !== undefined) free = Math.min(free, typeCap  - typeCount)
    return Math.max(0, free)
}

/**
 * Master predicate: can this module physically fit on this ship?
 *
 * @param mod          The candidate module / rig / subsystem.
 * @param ship         The hull. Must be a category-6 SdeType.
 * @param slot         Slot the user is trying to fill (HIGH/MED/LO/RIG/SUBSYSTEM/SERVICE).
 * @param fitContext   Optional current fit + dataset reference. When
 *                     supplied, the predicate ALSO enforces
 *                     `maxGroupFitted` / `maxTypeFitted` against the
 *                     existing modules (one Breacher Pod Launcher per
 *                     ship, one Bastion Module per ship, …). Omit for the
 *                     "is this combo even possible?" stateless check.
 */
export function canFitModuleOnShip(
    mod: SdeType,
    ship: SdeType | null | undefined,
    slot: SlotType,
    fitContext?: {
        fittedModules: Array<{ typeID: number }>
        dataset: { getType(id: number): SdeType | undefined }
    },
): { ok: boolean; reason?: string } {
    // 1. Slot match — first cut, very cheap.
    if (!typeFitsSlotType(mod, slot)) {
        return { ok: false, reason: `Module does not declare a ${slot} slot effect` }
    }

    if (!ship) return { ok: true }

    // 2-3. canFitShipGroup1-9 + canFitShipType1-4 — these two attribute
    // families form an OR-set in EVE: a module fits a hull if EITHER the
    // ship's groupID is in canFitShipGroup* OR the ship's typeID is in
    // canFitShipType*. AND-ing them rejects valid hulls — e.g. the
    // Compact Interdiction Nullifier declares canFitShipType1=34590 (the
    // Victorieux Yacht) AND canFitShipGroup*={831,1202,380,963,830,28,5087}
    // (Strategic Cruiser among others). AND-logic would reject the Legion
    // because its typeID 29986 ≠ 34590, even though its groupID 963 is
    // explicitly whitelisted.
    const allowedGroups = shipGroupRestrictions(mod)
    const allowedTypes  = shipTypeRestrictions(mod)
    if (allowedGroups.length > 0 || allowedTypes.length > 0) {
        const groupOk = allowedGroups.includes(ship.groupID)
        const typeOk  = allowedTypes.includes(ship.id)
        if (!groupOk && !typeOk) {
            return { ok: false, reason: 'Ship hull/group not allowed by this module' }
        }
    }

    // 4. Rig size: RIG slot only — module's rigSize must match ship's.
    if (slot === 'RIG') {
        const modSize = readAttr(mod, ATTR.RIG_SIZE)
        const shipSize = readAttr(ship, ATTR.RIG_SIZE)
        if (modSize != null && shipSize != null && Math.round(modSize) !== Math.round(shipSize)) {
            return { ok: false, reason: 'Rig size mismatch' }
        }
    }

    // 5. Subsystem: must fit this exact ship type (handled by SubsystemRow,
    //    repeated here as a safety net).
    if (slot === 'SUBSYSTEM') {
        const fitsTo = readAttr(mod, 1380)
        if (fitsTo != null && fitsTo > 0 && Math.round(fitsTo) !== ship.id) {
            return { ok: false, reason: 'Subsystem locked to a different T3C hull' }
        }
    }

    // 6. Hardpoint requirements for HI-slot weapons. Smart bombs and
    //    utility highs (cyno, salvager, etc.) don't consume hardpoints.
    if (slot === 'HI') {
        if (isTurretWeapon(mod)) {
            const turrets = readAttr(ship, ATTR.TURRET_HARDPOINTS) ?? 0
            if (turrets <= 0) {
                return { ok: false, reason: 'Ship has no turret hardpoints' }
            }
        } else if (isMissileLauncher(mod)) {
            const launchers = readAttr(ship, ATTR.LAUNCHER_HARDPOINTS) ?? 0
            if (launchers <= 0) {
                return { ok: false, reason: 'Ship has no launcher hardpoints' }
            }
        }
    }

    // 7. maxGroupFitted / maxTypeFitted (only when caller passes the
    //    current fit). Breacher Pod Launchers carry maxGroupFitted=1 so a
    //    second one on the same ship is rejected; Bastion Module is the
    //    classic maxTypeFitted=1 case.
    if (fitContext) {
        const free = freeFitGroupSlotsFor(mod, fitContext.fittedModules, fitContext.dataset)
        if (free <= 0) {
            const cap = maxTypeFittedFor(mod) ?? maxGroupFittedFor(mod)
            return { ok: false, reason: `Only ${cap} of this module type can be fitted to a ship` }
        }
    }

    return { ok: true }
}

/**
 * Returns the set of charge groupIDs accepted by this module — i.e. any
 * non-zero CHARGE_GROUP_1..5 attribute. Empty set means the module
 * doesn't take a charge (e.g. damage control, prop mod, smart bomb).
 */
export function chargeGroupsForModule(mod: SdeType): number[] {
    const out: number[] = []
    for (const attrID of CHARGE_GROUP_ATTRS) {
        const v = readAttr(mod, attrID)
        if (v != null && v > 0) out.push(Math.round(v))
    }
    return out
}

/** True if the module declares any chargeGroup attribute — i.e. it takes
 *  ammo / a script / cap booster charges / etc. */
export function moduleAcceptsAnyCharge(mod: SdeType): boolean {
    return chargeGroupsForModule(mod).length > 0
}

/**
 * Charge-fits-module predicate. Both must pass:
 *   1. charge.groupID ∈ module's CHARGE_GROUP_1..5
 *   2. charge size ≤ module's chargeSize (when both declare CHARGE_SIZE).
 *      Modules without an explicit chargeSize accept any size.
 */
export function moduleAcceptsChargeType(mod: SdeType, charge: SdeType): boolean {
    const allowedGroups = chargeGroupsForModule(mod)
    if (allowedGroups.length === 0) return false
    if (!allowedGroups.includes(charge.groupID)) return false

    const modSize = readAttr(mod, ATTR.CHARGE_SIZE)
    const chargeSize = readAttr(charge, ATTR.CHARGE_SIZE)
    if (modSize != null && chargeSize != null && Math.round(chargeSize) > Math.round(modSize)) {
        return false
    }
    return true
}

const ACTIVE_EFFECT_CATEGORIES = new Set([1, 2, 3])

/**
 * True iff the module declares at least one activation-class effect
 * (cat 1=active, 2=target-attack, 3=area). These modules accept the
 * full ONLINE → ACTIVE → OVERLOAD cycle. Pure-passive modules (rigs,
 * damage controls, gyrostabilizers, signal amplifiers, … with only
 * cat 0/4/6 effects) don't — they should never expose an "activate"
 * affordance in the UI because clicking changes nothing in the engine.
 */
export function isActivatableModule(
    mod: SdeType,
    effects: Map<number, { effectCategoryID?: number }>,
): boolean {
    for (const e of mod.effects) {
        const eff = effects.get(e.id)
        if (eff && eff.effectCategoryID !== undefined && ACTIVE_EFFECT_CATEGORIES.has(eff.effectCategoryID)) {
            return true
        }
    }
    return false
}

/** Module groups whose "active" state is operationally costly or
 *  intentionally toggled on-demand. These default to ONLINE — the user
 *  explicitly activates them when modeling a stealth/escape approach.
 *
 *  - 330  Cloaking Device — activating breaks combat-readiness (no other
 *    modules cycle while cloaked).
 *  - 4117 Interdiction Nullifier — single-use bubble immunity per cycle,
 *    you only activate it right before warping out; otherwise the
 *    fitted-not-active maluses (sig/scan res/drone bandwidth) are the
 *    interesting state to model.
 */
const DEFAULT_OFFLINE_ACTIVATION_GROUPS: ReadonlySet<number> = new Set([
    330,
    4117,
])

/**
 * Decide the default state a module should be in when newly fitted /
 * imported. Modules with at least one activation-class effect want to
 * be ACTIVE — that's where weapons, propulsion, hardeners, repairers,
 * EWAR all live. Pure-passive items stay ONLINE.
 *
 * Special case: Cloaking Devices (group 330) default to ONLINE even
 * though they're activatable, because activating one prevents the rest
 * of the fit from doing anything. The user can manually flip a cloak
 * to ACTIVE if they want to model a stealth approach.
 */
export function defaultStateForModule(
    mod: SdeType,
    effects: Map<number, { effectCategoryID?: number }>,
): 'ONLINE' | 'ACTIVE' {
    if (DEFAULT_OFFLINE_ACTIVATION_GROUPS.has(mod.groupID)) return 'ONLINE'
    return isActivatableModule(mod, effects) ? 'ACTIVE' : 'ONLINE'
}

/**
 * Hardpoint usage helper for the multi-fit drag-on-ship feature. Returns
 * how many turret/launcher hardpoints are still free given the current
 * fit, so we can decide how many copies of a weapon to drop in.
 */
export function freeHardpointsFor(
    mod: SdeType,
    ship: SdeType,
    fittedHiModules: Array<{ typeID: number }>,
    dataset: { getType(id: number): SdeType | undefined },
): number {
    const turretCap = readAttr(ship, ATTR.TURRET_HARDPOINTS) ?? 0
    const launcherCap = readAttr(ship, ATTR.LAUNCHER_HARDPOINTS) ?? 0

    let turretUsed = 0
    let launcherUsed = 0
    for (const m of fittedHiModules) {
        const t = dataset.getType(m.typeID)
        if (!t) continue
        if (isTurretWeapon(t)) turretUsed++
        else if (isMissileLauncher(t)) launcherUsed++
    }

    let hardpointFree: number
    if (isTurretWeapon(mod)) hardpointFree = Math.max(0, turretCap - turretUsed)
    else if (isMissileLauncher(mod)) hardpointFree = Math.max(0, launcherCap - launcherUsed)
    // Utility high-slots / smart bombs aren't hardpoint-bound; the only
    // limit is the empty HI slot count, which the caller computes.
    else hardpointFree = Number.POSITIVE_INFINITY

    // Cross-cap with maxGroupFitted / maxTypeFitted — Breacher Pod
    // Launchers stop at 1 even on hulls with multiple launcher slots.
    const groupFree = freeFitGroupSlotsFor(mod, fittedHiModules, dataset)
    return Math.min(hardpointFree, groupFree)
}
