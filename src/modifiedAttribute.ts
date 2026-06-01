/**
 * Per-attribute modification pipeline.
 *
 * One instance per (item × attributeID) holds:
 *  - the base value (from the SDE typeDogma row, possibly preassigned)
 *  - a flat list of "afflictions" — every modifier that's been applied
 *    during the calc pass (skills, ship bonuses, modules, fleet, etc.)
 *
 * `compute()` runs the EVE-canonical pipeline:
 *
 *     base ─► PreAssign override ─► PreMul/PreDiv (stack-penalized)
 *           ─► ModAdd/ModSub (additive)
 *           ─► PostMul/PostDiv/PostPercent (stack-penalized)
 *           ─► PostAssign override ─► (optional cap) ─► final
 *
 * `PostPercent` is treated identically to `PostMul(1 + value)` — see
 * https://wiki.eveuniversity.org/EVE_dogma_engine
 *
 * The afflictions list is preserved on the result so the UI can drill into
 * which sources contributed to a final value (Pyfa-style breakdown).
 */

import { ADDITIVE_OPS } from './constants'
import type { ModifierAffliction, ModifierOperation } from './types'
import { combineMultiplicative } from './stacking'

export class ModifiedAttribute {
    readonly attributeID: number
    readonly base: number
    readonly afflictions: ModifierAffliction[] = []

    private _cache: number | null = null

    constructor(attributeID: number, base: number) {
        this.attributeID = attributeID
        this.base = base
    }

    addAffliction(a: ModifierAffliction): void {
        this.afflictions.push(a)
        this._cache = null
    }

    /**
     * Reset all applied modifiers, keeping the base value. Used when the
     * engine re-runs (e.g. user toggles a module state).
     */
    reset(): void {
        this.afflictions.length = 0
        this._cache = null
    }

    /**
     * Compute the final value. Result is cached until `addAffliction()` or
     * `reset()` is called.
     *
     * @param maxAttribute optional cap — if provided, final value is clamped
     *                     to MIN(computed, maxAttribute). Used for attributes
     *                     with a maxAttributeID reference.
     */
    compute(maxAttribute?: number): number {
        if (this._cache !== null) return this._cache

        // Bucket afflictions by operation kind. Stable sort within each
        // bucket by insertion order — keeps PreAssign/PostAssign deterministic.
        const byOp = new Map<ModifierOperation, ModifierAffliction[]>()
        for (const a of this.afflictions) {
            const list = byOp.get(a.operation) ?? []
            list.push(a)
            byOp.set(a.operation, list)
        }

        let value = this.base

        // 1. PreAssign — last one wins (mirrors Pyfa's behaviour: a forced
        //    base value, but NOT a final lock; downstream ops still apply).
        const preAssign = byOp.get('PreAssign')
        if (preAssign && preAssign.length > 0) {
            value = preAssign[preAssign.length - 1]!.value
        }

        // 2. Pre-multiplication phase (stacking-penalized).
        const preMulEntries: Array<{ value: number; stackingGroup: string | null }> = []
        for (const a of byOp.get('PreMul') ?? []) {
            preMulEntries.push({ value: a.value, stackingGroup: a.stackingGroup })
        }
        for (const a of byOp.get('PreDiv') ?? []) {
            // Division becomes inverse multiplication so it can stack with
            // multipliers in the same penalty group.
            preMulEntries.push({ value: 1 / a.value, stackingGroup: a.stackingGroup })
        }
        if (preMulEntries.length > 0) {
            value *= combineMultiplicative(preMulEntries)
        }

        // 3. Additive phase. ADDITIVE_OPS spans ModAdd/ModSub; subtractions
        //    are stored as negative ModSub values for symmetry. No penalty.
        for (const op of ADDITIVE_OPS) {
            for (const a of byOp.get(op) ?? []) {
                value += op === 'ModSub' ? -a.value : a.value
            }
        }

        // 4. Post-multiplication phase (stacking-penalized).
        //
        // Pyfa parity: PostMul and PostPercent stack in SEPARATE penalty
        // pools per attribute. Pyfa's `eos/calc.py` keys penalty groups by
        // `(operator, penalized)`, so a Siege Module's PostPercent damage
        // bonus does NOT compete with Magnetic Field Stabilizer II's
        // PostMul damage bonus — both apply at full strength minus their
        // own intra-pool penalty.
        //
        // Empirically: Moros + 3× Ion Siege Blaster II + Siege Module II
        // + 2× MagStab II lands at Pyfa's 13 161 weapon DPS only when the
        // Siege Module bonus and the MagStabs are in different stacking
        // pools. Combining them undershoots by ~4 % (gives 12 648).
        //
        // PostDiv stays grouped with PostMul (mathematically identical
        // operator, just inverted value). PostPercent is its own pool.
        const postMulEntries: Array<{ value: number; stackingGroup: string | null }> = []
        for (const a of byOp.get('PostMul') ?? []) {
            postMulEntries.push({ value: a.value, stackingGroup: a.stackingGroup })
        }
        for (const a of byOp.get('PostDiv') ?? []) {
            postMulEntries.push({ value: 1 / a.value, stackingGroup: a.stackingGroup })
        }
        if (postMulEntries.length > 0) {
            value *= combineMultiplicative(postMulEntries)
        }
        const postPercentEntries: Array<{ value: number; stackingGroup: string | null }> = []
        for (const a of byOp.get('PostPercent') ?? []) {
            // PostPercent semantic: a value of 0.05 means "+5%" → 1.05 mul.
            postPercentEntries.push({ value: 1 + a.value, stackingGroup: a.stackingGroup })
        }
        if (postPercentEntries.length > 0) {
            value *= combineMultiplicative(postPercentEntries)
        }

        // 5. PostAssign — last one wins. This OVERRIDES everything before it,
        //    matching EVE's semantics for `force()`-style modifiers.
        const postAssign = byOp.get('PostAssign')
        if (postAssign && postAssign.length > 0) {
            value = postAssign[postAssign.length - 1]!.value
        }

        // 6. Optional cap.
        if (maxAttribute !== undefined && Number.isFinite(maxAttribute)) {
            value = Math.min(value, maxAttribute)
        }

        this._cache = value
        return value
    }

    /**
     * Compute and bundle into a ComputedAttribute (for UI consumption /
     * breakdown rendering). The afflictions array is shared by reference;
     * callers should not mutate it.
     */
    snapshot(maxAttribute?: number): {
        id: number
        base: number
        final: number
        afflictions: ModifierAffliction[]
    } {
        return {
            id: this.attributeID,
            base: this.base,
            final: this.compute(maxAttribute),
            afflictions: this.afflictions,
        }
    }
}
