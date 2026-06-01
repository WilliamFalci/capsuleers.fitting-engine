/**
 * Effective HitPoints (EHP) calculation.
 *
 * EVE damage application per layer:
 *   damage_taken = damage_dealt × (1 - resistance)
 *
 * For incoming damage with a known type distribution (DamageProfile):
 *   absorbed_per_layer = sum over types: weight × HP / (1 - resistance_type)
 *
 * Equivalent and easier to compute:
 *   effective_resistance = sum(weight × resistance_type)
 *   ehp_layer = HP / (1 - effective_resistance)
 *
 * `ehpUniform` uses a uniform 25% per type (used as a default badge in the UI).
 * `ehpAgainstProfile` uses the user-supplied DamageProfile weights.
 *
 * Important: the SDE stores resistances as RESONANCE values (0..1) where
 * 0 = full resist and 1 = no resist. The fitting engine consumes those raw,
 * but the UI prefers the inverted "resist %" form. Conversion happens here:
 *   resist_percent = 1 - resonance
 */

import { ATTR } from '../constants'
import type { ItemState } from '../itemState'
import type { DamageProfile } from '../types'

export type DefenseLayerKind = 'SHIELD' | 'ARMOR' | 'HULL'

interface LayerAttributeMap {
    hp: number
    em: number
    thermal: number
    kinetic: number
    explosive: number
}

const LAYER_ATTRS: Record<DefenseLayerKind, LayerAttributeMap> = {
    SHIELD: {
        hp: ATTR.SHIELD_CAPACITY,
        em: ATTR.SHIELD_EM_RES,
        thermal: ATTR.SHIELD_THERMAL_RES,
        kinetic: ATTR.SHIELD_KINETIC_RES,
        explosive: ATTR.SHIELD_EXPLOSIVE_RES,
    },
    ARMOR: {
        hp: ATTR.ARMOR_HP,
        em: ATTR.ARMOR_EM_RES,
        thermal: ATTR.ARMOR_THERMAL_RES,
        kinetic: ATTR.ARMOR_KINETIC_RES,
        explosive: ATTR.ARMOR_EXPLOSIVE_RES,
    },
    HULL: {
        hp: ATTR.HP,
        em: ATTR.STRUCTURE_EM_RES,
        thermal: ATTR.STRUCTURE_THERMAL_RES,
        kinetic: ATTR.STRUCTURE_KINETIC_RES,
        explosive: ATTR.STRUCTURE_EXPLOSIVE_RES,
    },
}

const UNIFORM_PROFILE: DamageProfile = {
    name: 'Uniform',
    em: 0.25,
    thermal: 0.25,
    kinetic: 0.25,
    explosive: 0.25,
    isPreset: true,
}

export interface LayerEhp {
    hp: number
    /** EHP under uniform 25%/type damage. Pyfa's "Uniform" reference. */
    ehpUniform: number
    /** EHP under the supplied profile (or uniform when no profile is given). */
    ehpAgainstProfile: number
    /** Resist percentages (0..1) for the UI. 1 - resonance. */
    resistances: { em: number; thermal: number; kinetic: number; explosive: number }
}

/**
 * Compute EHP for a single defense layer. Caller passes the ship state and
 * a DamageProfile; both omni-EHP and profile-EHP are returned together so
 * the UI can render a comparison.
 */
export function computeLayerEhp(
    ship: ItemState,
    layer: DefenseLayerKind,
    profile: DamageProfile | null = null,
): LayerEhp {
    const attrs = LAYER_ATTRS[layer]
    const hp = ship.getFinal(attrs.hp, 0)

    // Resonances: SDE convention. Default 1 means "no resist" — yields full
    // damage taken, which is what we want for missing layers (e.g. structure
    // for ships that genuinely have 0% resist by default).
    const resEm = ship.getFinal(attrs.em, 1)
    const resTh = ship.getFinal(attrs.thermal, 1)
    const resKi = ship.getFinal(attrs.kinetic, 1)
    const resEx = ship.getFinal(attrs.explosive, 1)

    return {
        hp,
        ehpUniform: ehpUnderProfile(hp, resEm, resTh, resKi, resEx, UNIFORM_PROFILE),
        ehpAgainstProfile: ehpUnderProfile(hp, resEm, resTh, resKi, resEx, profile ?? UNIFORM_PROFILE),
        resistances: {
            em: 1 - resEm,
            thermal: 1 - resTh,
            kinetic: 1 - resKi,
            explosive: 1 - resEx,
        },
    }
}

/**
 * Pure math: HP under a damage profile. Resonances passed verbatim from the
 * SDE (0 = full resist, 1 = no resist).
 *
 * Returns Infinity if the layer is mathematically immune (resonance=0
 * across all types with non-zero weight). The caller should clamp to a
 * sensible display value.
 */
export function ehpUnderProfile(
    hp: number,
    resonanceEm: number,
    resonanceThermal: number,
    resonanceKinetic: number,
    resonanceExplosive: number,
    profile: DamageProfile,
): number {
    if (hp <= 0) return 0
    const totalWeight = profile.em + profile.thermal + profile.kinetic + profile.explosive
    if (totalWeight <= 0) return hp  // degenerate profile → return raw HP

    // Effective resonance under this damage profile. Lower = better tank.
    const effectiveResonance = (
        profile.em * resonanceEm +
        profile.thermal * resonanceThermal +
        profile.kinetic * resonanceKinetic +
        profile.explosive * resonanceExplosive
    ) / totalWeight

    if (effectiveResonance <= 0) return Infinity  // immune
    return hp / effectiveResonance
}

/**
 * Combined EHP across all three layers. The "total" EHP a ship can absorb
 * before going pop is the sum of shield + armor + hull EHP under the same
 * damage profile (they're consumed sequentially in EVE).
 */
export function computeTotalEhp(
    shield: LayerEhp,
    armor: LayerEhp,
    hull: LayerEhp,
    useProfile: boolean,
): number {
    const pick = useProfile
        ? (l: LayerEhp) => l.ehpAgainstProfile
        : (l: LayerEhp) => l.ehpUniform
    const total = pick(shield) + pick(armor) + pick(hull)
    return Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER
}
