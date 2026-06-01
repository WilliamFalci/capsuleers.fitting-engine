/**
 * EWAR (Electronic Warfare) classifier.
 *
 * Identifies hostile modules that project an electronic effect onto a target
 * and surfaces the per-effect data needed to render an accurate "under
 * pressure" view:
 *   - ECM:                 stochastic (jam chance per cycle)
 *   - Sensor Dampener:     deterministic (lock range / scan res reduction)
 *   - Tracking Disruptor:  deterministic (turret tracking / range reduction)
 *   - Stasis Web:          deterministic (max velocity reduction)
 *   - Warp Scrambler/Disr: deterministic (warp ability)
 *   - Energy Neutralizer:  deterministic (cap drain on target)
 *   - Energy Vampire:      deterministic (cap transfer to source)
 *
 * The deterministic effects are already handled by the generic modifier
 * engine (their modifierInfo applies via `domain: targetID`). This file
 * exists to:
 *  1. Classify a module as EWAR for UI rendering
 *  2. Compute the stochastic ECM jam chance (which has no modifierInfo
 *     equivalent — it's read against the target's sensor strengths)
 *
 * ECM jam chance formula (canonical):
 *   per_type_chance = ecm_strength_per_type / target_sensor_strength_per_type
 *   per_cycle_chance = max across the four types
 *
 * Each ECM module fires once per cycle, with a per-cycle probability equal
 * to `per_cycle_chance` clamped to [0, 1]. Multiple ECMs combine via:
 *   combined = 1 - product(1 - p_i)
 */

import { ATTR } from '../constants'
import type { ItemState } from '../itemState'

export type EwarKind =
    | 'ECM'
    | 'SENSOR_DAMP'
    | 'TRACKING_DISRUPT'
    | 'WEB'
    | 'WARP_SCRAM'
    | 'WARP_DISRUPT'
    | 'NEUT'
    | 'NOS'
    | 'OTHER'

/**
 * Effect IDs that flag a module as EWAR. Multiple effects per kind are
 * possible (script-swappable modules carry both effects). Lookup is by
 * effect id; the first match wins.
 */
const EWAR_EFFECT_KIND: Record<number, EwarKind> = {
    1786: 'ECM',                  // ECM: jam target ship
    1130: 'SENSOR_DAMP',          // sensor dampener
    1799: 'TRACKING_DISRUPT',     // tracking disruptor (turret)
    14:   'WEB',                  // statisWeb
    19:   'WARP_SCRAM',           // warpScrambler
    52:   'WARP_DISRUPT',         // warpDisrupt (long-point disruptor)
    28:   'NEUT',                 // energyNeutralize
    1:    'NOS',                  // nosferatu
}

/**
 * Identify an EWAR module. Returns null if the module isn't EWAR.
 */
export function classifyEwar(item: ItemState): { kind: EwarKind; effectID: number } | null {
    for (const eid of item.effectIDs) {
        const kind = EWAR_EFFECT_KIND[eid]
        if (kind) return { kind, effectID: eid }
    }
    return null
}

/**
 * Compute a single ECM module's per-cycle jam chance against a given target.
 * Picks the maximum of the four sensor-type chances (RADAR/LADAR/MAG/GRAV).
 *
 * Returns 0 if the source lacks ECM strength attributes (defensive fallback).
 */
export function ecmJamChance(source: ItemState, target: ItemState): number {
    // Per-type strengths on the ECM module:
    //   208 = scanRadarStrength
    //   209 = scanLadarStrength
    //   210 = scanMagnetometricStrength
    //   211 = scanGravimetricStrength
    // The target's matching strength is read from the SAME attribute IDs on
    // the target's ship (only one of the four is non-zero per ship — the
    // race-specific one). Worst-case for the defender: their ECM resistance
    // is the strength of their own active sensor type.
    const pairs: Array<[number, number]> = [
        [ATTR.SCAN_RADAR_STRENGTH, ATTR.SCAN_RADAR_STRENGTH],
        [ATTR.SCAN_LADAR_STRENGTH, ATTR.SCAN_LADAR_STRENGTH],
        [ATTR.SCAN_MAGNETOMETRIC_STRENGTH, ATTR.SCAN_MAGNETOMETRIC_STRENGTH],
        [ATTR.SCAN_GRAVIMETRIC_STRENGTH, ATTR.SCAN_GRAVIMETRIC_STRENGTH],
    ]
    let best = 0
    for (const [srcAttr, tgtAttr] of pairs) {
        const srcStrength = source.getFinal(srcAttr, 0)
        if (srcStrength <= 0) continue
        const tgtStrength = target.getFinal(tgtAttr, 0)
        if (tgtStrength <= 0) continue
        const chance = srcStrength / tgtStrength
        if (chance > best) best = chance
    }
    return Math.max(0, Math.min(1, best))
}

/**
 * Combine independent per-cycle jam chances across multiple ECM modules
 * into a single combined "any jam this cycle" probability via:
 *   1 - product(1 - p_i)
 */
export function combineJamChances(chances: readonly number[]): number {
    let probNotJammed = 1
    for (const p of chances) {
        if (p <= 0) continue
        probNotJammed *= (1 - Math.max(0, Math.min(1, p)))
    }
    return 1 - probNotJammed
}
