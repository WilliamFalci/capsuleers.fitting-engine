/**
 * FitContext aggregates every ItemState participating in a single fit
 * computation: the ship, the module list, drones, fighters, implants,
 * boosters, subsystems, the mode (T3D/T3C), the character (skill source),
 * and an optional projected target for ranged DPS / EWAR projection.
 *
 * It also implements the `domain` resolution required by EVE's modifierInfo
 * model:
 *   - 'self'        → the source item itself
 *   - 'shipID'      → the ship hull
 *   - 'char'        → the character (where skills live)
 *   - 'otherID'     → the paired item (charge ↔ module)
 *   - 'targetID'    → the projected target (for hostile EWAR)
 *   - 'structureID' → citadel structures (rarely used for fits)
 *
 * `LocationGroupModifier` and `LocationRequiredSkillModifier` further filter
 * within the resolved location — see `targetsForModifier()`.
 */

import { CHARGE_GROUP_ATTRS, REQUIRED_SKILL_PAIRS } from './constants'
import type { ItemState } from './itemState'
import type { FittingDataset, SdeModifierInfo, SdeType, SkillProfile } from './types'

export interface FitContextInit {
    ship: ItemState
    character: ItemState
    /** Skill levels keyed by skill type id. Missing entries default to 0. */
    skillLevels: ReadonlyMap<number, number>
    modules: ItemState[]
    drones: ItemState[]
    fighters: ItemState[]
    implants: ItemState[]
    boosters: ItemState[]
    subsystems: ItemState[]
    mode?: ItemState
    /** Optional projected target. NULL when no target is selected. */
    target?: ItemState | null
    /** Optional citadel/structure context for structure modifierInfo. */
    structure?: ItemState | null
    skillProfile: SkillProfile
    /** Dataset reference — needed for transitive skill prerequisite walks
     *  (`itemRequiresSkillTransitive`). The skills bucket on the dataset is
     *  the only place skill type definitions live. */
    dataset: FittingDataset
    /** Triglavian disintegrator spool fraction (0..1). Stored on the
     *  context so derived/offense.ts can compute the spool=0 baseline DPS
     *  for the UI (Min/Max labels) without re-running the engine. Without
     *  this, the slider drag produces a brief race where the spool % has
     *  updated but the engine's output hasn't, and the derived Min/Max
     *  drift visibly until the debounced recompute settles. */
    disintegratorSpoolPercent: number
}

export class FitContext {
    readonly ship: ItemState
    readonly character: ItemState
    readonly skillLevels: ReadonlyMap<number, number>
    readonly modules: ItemState[]
    readonly drones: ItemState[]
    readonly fighters: ItemState[]
    readonly implants: ItemState[]
    readonly boosters: ItemState[]
    readonly subsystems: ItemState[]
    readonly mode: ItemState | null
    /** Mutable so projection passes can temporarily redirect `targetID`
     *  domain resolution (e.g. when applying hostile EWAR onto your own
     *  fit, target is swapped to ctx.ship). The engine restores it after. */
    target: ItemState | null
    readonly structure: ItemState | null
    readonly skillProfile: SkillProfile
    readonly dataset: FittingDataset
    readonly disintegratorSpoolPercent: number
    /** Projected hostile sources currently in scope. Populated by the
     *  engine when ProjectedSource[] is passed in ComputeFitOptions. */
    projectedSources: ItemState[] = []

    /** Effect IDs the dispatcher must skip when applying LOCAL modules
     *  (modules fitted to ctx.ship). Populated by `collectEffectStoppers()`
     *  during the projection pre-pass: each `func: EffectStopper`
     *  modifierInfo on a projected source contributes its `effectID` here.
     *
     *  Pyfa-parity: warp scrambler / disruptor effects (5928, 5934, 6745,
     *  …) suppress effects 6441 (MWD) and 6442 (MJD) on the target — the
     *  scrambled ship can't activate its prop module. The engine reads
     *  this set inside `applySourceItem` and skips matching effects on
     *  ship-mounted modules. Empty by default = no projected scram. */
    stoppedLocalEffectIDs: Set<number> = new Set()

    constructor(init: FitContextInit) {
        this.ship = init.ship
        this.character = init.character
        this.skillLevels = init.skillLevels
        this.modules = init.modules
        this.drones = init.drones
        this.fighters = init.fighters
        this.implants = init.implants
        this.boosters = init.boosters
        this.subsystems = init.subsystems
        this.mode = init.mode ?? null
        this.target = init.target ?? null
        this.structure = init.structure ?? null
        this.skillProfile = init.skillProfile
        this.dataset = init.dataset
        this.disintegratorSpoolPercent = init.disintegratorSpoolPercent
    }

    /** All items that can carry effects + receive modifications. */
    *allItems(): IterableIterator<ItemState> {
        yield this.ship
        yield this.character
        for (const m of this.modules) yield m
        for (const m of this.modules) if (m.charge) yield m.charge
        for (const d of this.drones) yield d
        for (const f of this.fighters) yield f
        for (const i of this.implants) yield i
        for (const b of this.boosters) yield b
        for (const s of this.subsystems) yield s
        if (this.mode) yield this.mode
        if (this.target) yield this.target
        if (this.structure) yield this.structure
    }

    /** Skill level lookup with default 0 for untrained skills. */
    skillLevel(skillTypeID: number): number {
        return this.skillLevels.get(skillTypeID) ?? 0
    }

    /**
     * Resolve the `domain` string of a modifier into the corresponding root
     * ItemState. The `source` is the item carrying the effect (e.g. the
     * module whose effect we're applying); `self` resolves to it directly.
     */
    resolveDomain(domain: SdeModifierInfo['domain'], source: ItemState): ItemState | null {
        switch (domain) {
            case 'self':
            case 'itemID':           // SDE alias for self
                return source
            case 'shipID':
                return this.ship
            case 'char':
            case 'charID':           // SDE alias for char (most common in skill effects)
                return this.character
            case 'otherID':
                // Charge↔module pairing. From a module's perspective, otherID
                // is the loaded charge; from a charge's perspective, it's
                // the parent module. We can't resolve the latter direction
                // from the source alone — the caller must pass the parent
                // module via FitContext.findChargeParent if needed.
                if (source.kind === 'module') return source.charge ?? null
                if (source.kind === 'charge') return this.findChargeParent(source) ?? null
                return null
            case 'targetID':
            case 'target':           // SDE alias for targetID
                return this.target
            case 'structureID':
                return this.structure
        }
    }

    /** Find which module currently has the given charge loaded. */
    findChargeParent(charge: ItemState): ItemState | null {
        for (const m of this.modules) {
            if (m.charge === charge) return m
        }
        return null
    }

    /**
     * Resolve the target list for a modifier — combination of `func` +
     * `domain` + (optional) `groupID` / `skillTypeID` filter.
     *
     * - ItemModifier: applies to the single domain item.
     * - LocationModifier: applies to the location root (typically the ship)
     *   AND to every item physically located in that location (modules,
     *   drones, etc.) — interpretation depends on context, but most
     *   modifierInfo entries we encounter use it for the root only.
     *   Conservative: target the location root only. The few effects that
     *   actually want "every item in the location" are usually duplicated
     *   as LocationGroupModifier with no group filter — handled there.
     * - LocationGroupModifier: every item in the location whose groupID
     *   matches modifier.groupID.
     * - LocationRequiredSkillModifier: every item in the location that
     *   requires the skill modifier.skillTypeID.
     * - OwnerRequiredSkillModifier: every item owned by the character that
     *   requires the skill — i.e. modules + drones + fighters across the
     *   fit. Used by skill bonuses that should apply regardless of where
     *   the item is mounted.
     * - EffectStopper: handled outside this resolver (stops other effects
     *   rather than applying a modifier).
     */
    targetsForModifier(modifier: SdeModifierInfo, source: ItemState): ItemState[] {
        const root = this.resolveDomain(modifier.domain, source)
        switch (modifier.func) {
            case 'ItemModifier':
                // BCS-style charge boost (Pyfa-parity): a module ItemModifier
                // with `domain="charID"` that targets `missileDamageMultiplier`
                // (attr 212) boosts its sibling launchers' LOADED CHARGES, not
                // the character. Effect 763 `missileDMGBonus` is the canonical
                // example: a Ballistic Control System's attr_213 PreMul-boosts
                // attr_212 on the ammo inside any missile launcher. Without
                // this re-routing BCS damage silently misses (~17 % missile DPS
                // on a 2-BCS fit).
                //
                // This re-route is SCOPED to attr 212 — other module
                // charID-ItemModifier effects legitimately target the CHARACTER
                // (Drone Link Augmentor → droneControlDistance attr 458, Drone
                // Control Unit → maxActiveDrones attr 352, etc.). Routing those
                // to the (non-existent) loaded charge dropped the bonus
                // entirely — e.g. a Drone Link Augmentor added 0 km of drone
                // control range instead of +20/+24 km.
                if (modifier.domain === 'charID' && source.kind === 'module'
                    && modifier.modifiedAttributeID === 212) {
                    const out: ItemState[] = []
                    for (const m of this.modules) {
                        if (m.charge) out.push(m.charge)
                    }
                    return out
                }
                return root ? [root] : []

            case 'LocationModifier':
                return root ? [root] : []

            case 'LocationGroupModifier': {
                if (!root || modifier.groupID === undefined) return []
                return this.itemsInLocation(root).filter(it => it.groupID === modifier.groupID)
            }

            case 'LocationRequiredSkillModifier': {
                if (!root || modifier.skillTypeID === undefined) return []
                const sid = modifier.skillTypeID
                // DIRECT skill match (Pyfa-parity). DO NOT use transitive
                // closure — Pyfa's `requiresSkill` matches only the item's
                // directly-declared required skills. Transitive matching
                // double-counts skill bonuses across prerequisite chains.
                // Example: Scourge Rage HAM directly requires HAMs (25719);
                // HAMs prereqs include Light Missiles (3321). Subsystem
                // effect 4362 has separate modifiers for {Light, Heavy,
                // HAMs} skills × 4 damage types. With transitive matching
                // both the HAMs and Light Missiles modifiers fire on the
                // ammo (1.25 × 1.25 = 1.5625× extra damage). Direct
                // matching only fires the HAMs modifier (1.25×).
                return this.itemsInLocation(root).filter(it => itemRequiresSkill(it, sid))
            }

            case 'OwnerRequiredSkillModifier': {
                if (modifier.skillTypeID === undefined) return []
                const skillID = modifier.skillTypeID
                const out: ItemState[] = []
                for (const m of this.modules) {
                    if (itemRequiresSkill(m, skillID)) out.push(m)
                    // Loaded charges are owned by the character too — missile
                    // damage skill bonuses (Warhead Upgrades / Missile
                    // Launcher Op family) target the AMMO's em/thermal/
                    // kinetic/explosive damage attrs, not the launcher's.
                    if (m.charge && itemRequiresSkill(m.charge, skillID)) out.push(m.charge)
                }
                for (const d of this.drones) if (itemRequiresSkill(d, skillID)) out.push(d)
                for (const f of this.fighters) if (itemRequiresSkill(f, skillID)) out.push(f)
                return out
            }

            case 'EffectStopper':
                return []
        }
    }

    /**
     * Items that count as "located in" a given root. The exact set depends
     * on the root kind:
     *   - Ship: the ship itself + every module + active drone/fighter +
     *     subsystems + mode + charges
     *   - Character: every char-attached item (the character itself,
     *     implants, boosters)
     *   - Anything else: just the root (no spreading)
     *
     * This mirrors Pyfa's location semantics.
     */
    private itemsInLocation(root: ItemState): ItemState[] {
        if (root === this.ship) {
            const out: ItemState[] = [this.ship]
            for (const m of this.modules) {
                out.push(m)
                if (m.charge) out.push(m.charge)
            }
            for (const d of this.drones) out.push(d)
            for (const f of this.fighters) out.push(f)
            for (const s of this.subsystems) out.push(s)
            if (this.mode) out.push(this.mode)
            return out
        }
        if (root === this.character) {
            const out: ItemState[] = [this.character]
            for (const i of this.implants) out.push(i)
            for (const b of this.boosters) out.push(b)
            return out
        }
        return [root]
    }
}

/** True when the item declares the given skill as one of its requirements. */
export function itemRequiresSkill(item: ItemState, skillID: number): boolean {
    for (const [skillAttr] of REQUIRED_SKILL_PAIRS) {
        if (item.getBase(skillAttr) === skillID) return true
    }
    return false
}

/**
 * Transitive variant: true when the item requires `skillID` either directly
 * OR via one of its required skills' prerequisite chain. This matters for
 * Pyfa-parity bonus targeting — e.g. Heavy Assault Missile Launchers
 * directly require `Heavy Assault Missile Specialization` (25718) which
 * itself requires `Heavy Assault Missiles` (25719). T3C subsystem bonuses
 * scoped to skill 25719 (Heavy Assault Missiles) must apply to those
 * launchers, but the direct check returns false because 25719 isn't on the
 * launcher's required list.
 *
 * Implementation: BFS over the direct required skills, walking each skill
 * type's own REQUIRED_SKILL_PAIRS attributes. The skill bucket on the
 * dataset is the only place skill type definitions live. Memoised per
 * (item.typeID × skillID) at the dataset level — without caching every
 * single OwnerRequiredSkillModifier invocation pays for the BFS again.
 */
const txSkillCache = new WeakMap<FittingDataset, Map<number, Set<number>>>()

export function expandRequiredSkillsTransitive(
    item: ItemState,
    dataset: FittingDataset,
): Set<number> {
    let perType = txSkillCache.get(dataset)
    if (!perType) {
        perType = new Map()
        txSkillCache.set(dataset, perType)
    }
    const cached = perType.get(item.typeID)
    if (cached) return cached

    const skillsBucket = dataset.typesByBucket.skills
    const out = new Set<number>()
    const queue: number[] = []
    for (const [skillAttr] of REQUIRED_SKILL_PAIRS) {
        const v = item.getBase(skillAttr)
        if (v && v > 0) queue.push(v)
    }
    while (queue.length > 0) {
        const sid = queue.pop()!
        if (out.has(sid)) continue
        out.add(sid)
        const skillType: SdeType | undefined = skillsBucket?.get(sid)
        if (!skillType) continue
        for (const [skillAttr] of REQUIRED_SKILL_PAIRS) {
            const prereq = skillType.attributes.find(a => a.id === skillAttr)?.v
            if (prereq && prereq > 0 && !out.has(prereq)) queue.push(prereq)
        }
    }
    perType.set(item.typeID, out)
    return out
}

export function itemRequiresSkillTransitive(
    item: ItemState,
    skillID: number,
    dataset: FittingDataset,
): boolean {
    return expandRequiredSkillsTransitive(item, dataset).has(skillID)
}

/** Charge-loadability check: charge.groupID must match one of the module's
 *  charge group attributes. Used by the editor to validate charge swaps. */
export function moduleAcceptsCharge(module: ItemState, charge: ItemState): boolean {
    for (const attrID of CHARGE_GROUP_ATTRS) {
        const allowed = module.getBase(attrID)
        if (allowed && allowed === charge.groupID) return true
    }
    return false
}
