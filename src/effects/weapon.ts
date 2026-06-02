/**
 * Weapon effect inspection — given an ItemState (a fitted module or a drone),
 * classify the kind of weapon and extract the canonical attributes used by
 * the offense aggregator: damage components, cycle time, range, falloff,
 * tracking, alpha multiplier, missile sig/velocity.
 *
 * What this file deliberately does NOT do:
 *   - Apply tracking against a target (offense.ts handles that — this file
 *     only surfaces the raw attributes)
 *   - Compute applied DPS — same reason
 *   - Iterate the fit — caller picks one item and asks "is this a weapon?"
 *
 * The damage source for turrets/missiles is the LOADED CHARGE, not the
 * launcher. For smart bombs it's the launcher itself (no charge slot).
 * Drones carry damage attributes baked into the drone type.
 */

import { ATTR, WEAPON_EFFECT_KIND, type WeaponEffectKind } from '../constants'
import type { ItemState } from '../itemState'
import type { SdeEffect } from '../types'

export interface WeaponClassification {
    kind: WeaponEffectKind
    /** The dogma effect that classified this item as a weapon. Carries the
     *  duration / range / falloff / tracking attribute references. */
    effectID: number
    /** ItemState whose attributes provide the damage components. For turrets
     *  + missiles this is the loaded charge; for smart bombs it's the
     *  module itself; for drones it's the drone. May be null when the
     *  weapon has no ammo loaded → caller treats as zero damage. */
    damageSource: ItemState | null
}

/**
 * Detect the primary weapon effect on an item. Returns null if the item
 * isn't a weapon. If multiple weapon effects are present (rare — usually
 * only on items with both turret + smart-bomb effects historically), the
 * first match wins by `WEAPON_EFFECT_KIND` lookup order.
 */
export function classifyWeapon(item: ItemState): WeaponClassification | null {
    for (const eid of item.effectIDs) {
        const kind = WEAPON_EFFECT_KIND[eid]
        if (!kind) continue
        const damageSource =
            kind === 'TURRET' || kind === 'MISSILE'
                ? item.charge
                : item  // smart bombs / drones carry damage on themselves
        return { kind, effectID: eid, damageSource }
    }
    // Fallback for drones: drones have a damage multiplier and damage
    // attributes baked in but their classification effect varies (often
    // missileLaunching for missile drones, targetAttack for combat drones).
    // The classifyWeapon path above already catches those, so dronea
    // without one of those effects are non-combat (logistic / mining /
    // salvage drones) — return null.
    return null
}

export interface WeaponDamageComponents {
    em: number
    thermal: number
    kinetic: number
    explosive: number
    total: number
}

/**
 * Read the four damage components from a damage source. Empty (no ammo)
 * yields all-zero. Turret damage multiplier is NOT applied here — that's
 * the offense aggregator's concern (the multiplier sits on the LAUNCHER,
 * not on the charge).
 */
export function readDamageComponents(source: ItemState | null): WeaponDamageComponents {
    if (!source) return { em: 0, thermal: 0, kinetic: 0, explosive: 0, total: 0 }
    const em = source.getFinal(ATTR.EM_DAMAGE, 0)
    const thermal = source.getFinal(ATTR.THERMAL_DAMAGE, 0)
    const kinetic = source.getFinal(ATTR.KINETIC_DAMAGE, 0)
    const explosive = source.getFinal(ATTR.EXPLOSIVE_DAMAGE, 0)
    return { em, thermal, kinetic, explosive, total: em + thermal + kinetic + explosive }
}

export interface WeaponCycleInfo {
    cycleSeconds: number
    /** Damage multiplier applied per cycle. 1.0 for missiles / smart bombs;
     *  the launcher's `damageMultiplier` (attr 64) for turrets. Skill +
     *  module bonuses already baked in via the modifier engine. */
    damageMultiplier: number
}

export function readCycleInfo(item: ItemState, kind: WeaponEffectKind): WeaponCycleInfo {
    // Cycle attribute: turrets + missiles use ATTR.RATE_OF_FIRE (51);
    // smart bombs use ATTR.DAMAGE_DURATION (73). Most modern modules have
    // both populated in their typeDogma (with the same value), so reading
    // either works — we prefer the canonical one per kind.
    const cycleAttr = kind === 'SMARTBOMB' ? ATTR.DAMAGE_DURATION : ATTR.RATE_OF_FIRE
    const cycleMs = item.getFinal(cycleAttr, 0)
    const cycleSeconds = cycleMs > 0 ? cycleMs / 1000 : 0

    let damageMultiplier = 1
    if (kind === 'TURRET') {
        damageMultiplier = item.getFinal(ATTR.DAMAGE_MULTIPLIER, 1)
    } else if (kind === 'MISSILE') {
        // EVE convention for missile launchers — per-cycle damage is:
        //     (em+therm+kin+exp) × charge.attr_212 (missileDamageMultiplier)
        //                       × launcher.attr_64 (damageMultiplier)
        // Most launchers have no `attr_64`; specialty launchers (Rapid Lights,
        // Bomb Launchers) do. The CHARGE'S `missileDamageMultiplier` (212)
        // starts at 1 and is boosted multiplicatively by every BCS / module
        // that targets attr_212 on the loaded charge (Pyfa effect
        // `missileDMGBonus`, attr_213 → attr_212 PreMul). Without reading the
        // charge's missileDamageMultiplier, BCS damage bonuses (typically
        // +10 % per BCS) silently drop, costing ~17 % missile DPS on a
        // 2-BCS fit.
        const launcherMul = item.getFinal(ATTR.DAMAGE_MULTIPLIER, 1)
        const chargeMul = item.charge?.getFinal(ATTR.MISSILE_DAMAGE_MULTIPLIER, 1) ?? 1
        damageMultiplier = launcherMul * chargeMul
    }
    return { cycleSeconds, damageMultiplier }
}

export interface WeaponRangeInfo {
    /** Optimal range in meters. 0 for missiles + smart bombs (range is
     *  tied to flight time × velocity for missiles). */
    optimal: number
    /** Falloff in meters — turret-specific. */
    falloff: number
    /** Tracking speed (rad/s) — turret-specific. */
    tracking: number
    /** Smart-bomb burst range (also used as effective hard cap). */
    burstRange: number
    /** Missile-specific: explosion radius (m). */
    explosionRadius: number
    /** Missile-specific: explosion velocity (m/s). */
    explosionVelocity: number
    /** Missile-specific: damage reduction factor (DRF). */
    drf: number
    /** Missile-specific: max flight range in meters — modified charge
     *  velocity × flight time (ship/skill/rig bonuses included). 0 otherwise. */
    flightRange: number
}

export function readRangeInfo(item: ItemState, effect: SdeEffect, kind: WeaponEffectKind): WeaponRangeInfo {
    // Range attribute IDs are listed on the EFFECT itself
    // (rangeAttributeID / falloffAttributeID / trackingSpeedAttributeID).
    // Reading via these indirections keeps us correct even if Fenris Creations renumbers
    // a custom effect's attribute references.
    const optimal = effect.rangeAttributeID
        ? item.getFinal(effect.rangeAttributeID, 0)
        : 0
    const falloff = effect.falloffAttributeID
        ? item.getFinal(effect.falloffAttributeID, 0)
        : 0
    const tracking = effect.trackingSpeedAttributeID
        ? item.getFinal(effect.trackingSpeedAttributeID, 0)
        : 0

    let burstRange = 0
    if (kind === 'SMARTBOMB' && effect.rangeAttributeID) {
        burstRange = optimal  // already loaded above
    }

    // Missile flight envelope — read from the CHARGE not the launcher.
    let explosionRadius = 0
    let explosionVelocity = 0
    let drf = 0
    let flightRange = 0
    if (kind === 'MISSILE' && item.charge) {
        explosionRadius = item.charge.getFinal(ATTR.EXPLOSION_RADIUS, 0)
        explosionVelocity = item.charge.getFinal(ATTR.EXPLOSION_VELOCITY, 0)
        drf = item.charge.getFinal(ATTR.DRF, 0)
        // Max range a missile reaches = modified velocity (m/s) × modified flight time (ms)
        // / 1000. Both attributes carry the ship/skill/rig bonuses applied to the charge.
        const velocity = item.charge.getFinal(ATTR.MAX_VELOCITY, 0)
        const flightMs = item.charge.getFinal(ATTR.EXPLOSION_DELAY, 0)
        flightRange = velocity * flightMs / 1000
    }

    return {
        optimal,
        falloff,
        tracking,
        burstRange,
        explosionRadius,
        explosionVelocity,
        drf,
        flightRange,
    }
}
