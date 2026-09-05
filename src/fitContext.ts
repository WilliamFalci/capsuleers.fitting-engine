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

import { ATTR, CHARGE_GROUP_ATTRS, REQUIRED_SKILL_PAIRS } from './constants'

/** Skills that mark a charge as a MISSILE for damage-module boosts — pyfa's
 *  own filter on the Ballistic Control System family (Effect763). */
const MISSILE_BOOST_SKILLS = [
    3319,  // Missile Launcher Operation
    3323,  // Defender Missiles
] as const

/**
 * Effects whose recipients pyfa picks by GROUP, though the SDE declares a
 * required-skill filter. Keep this list short and evidenced: it only exists
 * where the two disagree, which in practice means the skill-less Civilian
 * modules. `npm run diff` is what finds the next one.
 */
const PYFA_GROUP_FILTERED_EFFECTS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
    // 3495 shipCapPropulsionJamming — the Interceptor / Interdictor role bonus
    // to Warp Scrambler + Stasis Web capacitor need. pyfa:
    // `mod.item.group.name in ('Stasis Web', 'Warp Scrambler')`.
    [3495, new Set([52, 65])],
])
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
    targetsForModifier(modifier: SdeModifierInfo, source: ItemState, effectID?: number): ItemState[] {
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
                // Drone CONTROL RANGE accumulates on ONE value, and that value
                // is the ship's. Every SDE modifier for attr 458 is declared
                // `domain: charID` — the Drone Avionics skills, the Drone Link
                // Augmentor, the heavy-gunship bonus and the Griffin Navy
                // Issue's role penalty alike — while pyfa routes them all into
                // `fit.extraAttributes`, which IS the ship's attribute dict
                // (seeded to 20 km in `ship.py`). Sending them to the character
                // instead split the number in two halves that were summed at
                // the end, so a PERCENTAGE modifier only ever hit one of them:
                // the Griffin Navy Issue's -50% read as 20 km base + 20 km of
                // halved skills = 40 km, where the game and pyfa say 30.
                // Additive bonuses happened to survive the split, which is why
                // this stayed invisible until a hull applied a percentage.
                if (modifier.domain === 'charID'
                    && modifier.modifiedAttributeID === ATTR.DRONE_CONTROL_RANGE) {
                    return this.ship ? [this.ship] : []
                }
                if (modifier.domain === 'charID' && source.kind === 'module'
                    && modifier.modifiedAttributeID === 212) {
                    // Only charges that are actually MISSILES — pyfa's filter is
                    // `charge.requiresSkill('Missile Launcher Operation') or
                    // 'Defender Missiles'` (Effect763). Boosting every loaded
                    // charge caught the skill-less starter ammo: a fit carrying
                    // a Civilian Scourge Light Missile read 638.6 alpha where
                    // pyfa says 629.8, the whole difference being that one
                    // launcher pyfa does not boost.
                    const out: ItemState[] = []
                    for (const m of this.modules) {
                        if (!m.charge) continue
                        if (!MISSILE_BOOST_SKILLS.some(sid => itemRequiresSkill(m.charge!, sid))) continue
                        out.push(m.charge)
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
                if (!root) return []
                // A few pyfa handlers filter their recipients by GROUP where the
                // SDE declares a required-skill filter. The two pick the same
                // modules for everything a player actually fits — a Warp
                // Scrambler requires Propulsion Jamming — and diverge only on
                // the skill-less Civilian variants. Following the SDE there left
                // an intercepter's -80% capacitor role bonus off a Civilian Warp
                // Disruptor, so the module drained 5 GJ/s instead of 1 and the
                // hull emptied in 45 s against pyfa's 90.
                const groups = effectID === undefined ? undefined : PYFA_GROUP_FILTERED_EFFECTS.get(effectID)
                if (groups) return this.itemsInLocation(root).filter(it => groups.has(it.groupID))
                if (modifier.skillTypeID === undefined) return []
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
                    // Owner-domain (charID) skill modifiers reach the character's
                    // OWN items — drones, fighters, and loaded charges (missile
                    // damage skill bonuses like Warhead Upgrades / Missile
                    // Launcher Op target the AMMO's damage attrs) — but NEVER the
                    // ship-domain modules themselves. Pyfa's effect handlers
                    // (e.g. Effect6556 moduleBonusDroneDamageAmplifier) boost only
                    // fit.drones / fit.fighters, never modules.
                    //
                    // Self-targeting a module here is a real bug for the combo
                    // damage modules that BOTH boost turrets (effect 91/93
                    // energy/hybrid `LocationGroupModifier`, source attr 64) AND
                    // carry the drone amp (effect 6556, `OwnerRequiredSkillModifier`
                    // skillTypeID=Drones, attr 64). Those modules (Navy 'Neophyte'
                    // Heat Sink, 'Argyreos' Mag Field Stab, Abyssal BCS/Heat Sink/
                    // Mag Stab, …) REQUIRE the Drones skill, so they matched their
                    // own owner modifier and inflated their own `damageMultiplier`,
                    // which then leaked into the turret group bonus — e.g. a Freki
                    // armed with lasers + a 'Neophyte' Heat Sink read +50% turret
                    // damage that pyfa doesn't apply.
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
