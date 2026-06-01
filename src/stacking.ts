/**
 * Stacking penalty math.
 *
 * Per EVE rules: when multiple multiplicative modifiers stack on the same
 * attribute (and the attribute is NOT marked stackable in the SDE), the most
 * impactful modifier applies at full strength while subsequent ones are
 * exponentially attenuated:
 *
 *     effective_multiplier_i = 1 + (raw_i − 1) × exp(−i² / k)
 *
 * where i is the 0-indexed position after sorting by absolute deviation from
 * 1 (descending) and k = 7.1289.
 *
 * Bonuses (raw > 1) and penalties (raw < 1) are penalized as TWO INDEPENDENT
 * sequences — i.e. the strongest bonus is at full strength even if a stronger
 * penalty exists in the same group, and vice versa. This mirrors Pyfa's
 * `eos/calc.py::calculateMultiplier`.
 *
 * Skill bonuses, ship hull bonuses, and modules with the `stackable` flag
 * bypass this penalty entirely — they multiply at face value. The caller
 * decides whether to penalize via the `stackingGroup` field on the Affliction
 * (null = no penalty).
 */

import { STACKING_PENALTY_K } from './constants'

export interface StackableValue {
    /** Raw multiplier (1.05 = +5% bonus, 0.9 = -10% penalty). */
    value: number
}

/**
 * Reduce a list of multipliers from the same stacking group into a single
 * combined factor. Returns 1 for an empty list.
 */
export function combinePenalized(values: readonly StackableValue[]): number {
    if (values.length === 0) return 1

    // Split into bonuses and penalties — the EVE formula treats them as
    // independent stacks (a strong bonus + a strong penalty don't compete
    // for position 0).
    const bonuses = values.filter(v => v.value > 1)
    const penalties = values.filter(v => v.value < 1)
    const neutrals = values.filter(v => v.value === 1)

    // Sort by absolute deviation from 1, descending — most impactful first.
    bonuses.sort((a, b) => Math.abs(b.value - 1) - Math.abs(a.value - 1))
    penalties.sort((a, b) => Math.abs(b.value - 1) - Math.abs(a.value - 1))

    let factor = 1

    for (let i = 0; i < bonuses.length; i++) {
        const raw = bonuses[i]!.value
        const attenuation = Math.exp(-(i * i) / STACKING_PENALTY_K)
        factor *= 1 + (raw - 1) * attenuation
    }

    for (let i = 0; i < penalties.length; i++) {
        const raw = penalties[i]!.value
        const attenuation = Math.exp(-(i * i) / STACKING_PENALTY_K)
        factor *= 1 + (raw - 1) * attenuation
    }

    for (const _n of neutrals) factor *= 1  // explicit no-op for clarity

    return factor
}

/**
 * Combine UNSTACKED multiplicative modifiers — straight product, no penalty.
 */
export function combineUnstacked(values: readonly StackableValue[]): number {
    let factor = 1
    for (const v of values) factor *= v.value
    return factor
}

/**
 * Group a flat list of {value, stackingGroup} entries by their stacking
 * group key, then combine each group via the appropriate path.
 *
 * stackingGroup === null means "no penalty for this entry, multiply directly".
 * Other keys denote a penalty group (typically the attribute id, or
 * source-type:attribute).
 */
export function combineMultiplicative(
    entries: readonly { value: number; stackingGroup: string | null }[],
): number {
    if (entries.length === 0) return 1
    const groups = new Map<string, StackableValue[]>()
    const unstacked: StackableValue[] = []
    for (const e of entries) {
        if (e.stackingGroup === null) {
            unstacked.push({ value: e.value })
        } else {
            const list = groups.get(e.stackingGroup) ?? []
            list.push({ value: e.value })
            groups.set(e.stackingGroup, list)
        }
    }
    let factor = combineUnstacked(unstacked)
    for (const list of groups.values()) {
        factor *= combinePenalized(list)
    }
    return factor
}
