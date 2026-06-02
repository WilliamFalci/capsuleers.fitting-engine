/**
 * Generic modifierInfo dispatcher.
 *
 * For every dogma effect that has a populated `modifierInfo` array (~93% of
 * the SDE), this engine reads each entry, computes the final modifier value,
 * resolves the target list via the FitContext domain rules, and pushes an
 * Affliction onto each target's ModifiedAttribute pipeline.
 *
 * The remaining ~7% of effects (capacitor sim, weapon DPS, missile DRF,
 * EWAR projection probability, etc.) bypass this engine and run through
 * dedicated handlers in `effects/`. Those handlers are dispatched from the
 * top-level `engine.ts` orchestrator, NOT from here.
 *
 * Skill scaling: modifiers tagged `*RequiredSkillModifier` multiply the
 * source value by the character's skill level (0..5). The bonus value
 * stored on the source item is the per-level value (e.g. 5%/level →
 * the modifyingAttributeID points to an attribute whose value is 0.05).
 *
 * Stacking penalty key: defaults to `${attributeID}` so multiple modules
 * affecting the same attribute share a penalty stack. Skill / ship / mode /
 * subsystem sources bypass the penalty (`stackingGroup === null`) — these
 * are intrinsic bonuses that EVE does not penalize. The `stackable` flag
 * on the dogma attribute also bypasses (some attributes are explicitly
 * additive without penalty).
 */

import { OPERATION_BY_SDE_CODE } from './constants'
import { STACKING_PENALTY_GROUPS } from './stackingGroups'
import type { ItemState } from './itemState'
import type { FitContext } from './fitContext'
import { itemRequiresSkill } from './fitContext'
import type {
    FittingDataset,
    ModifierAffliction,
    ModifierOperation,
    SdeEffect,
    SdeModifierInfo,
} from './types'

/** Source kinds whose modifiers do NOT incur a stacking penalty. */
const NO_PENALTY_KINDS: ReadonlySet<ItemState['kind']> = new Set([
    'skill', 'ship', 'mode', 'subsystem', 'character',
] as Array<ItemState['kind']>)

/**
 * Dogma unit IDs that flag the source attribute as a "percent-typed"
 * value. The SDE stores these as the raw percent number (5 = 5%, not
 * 0.05).
 *
 *   105 = Percentage
 *   109 = Modifier Percent
 *   111 = Inversed Modifier Percent
 *   121 = realPercent
 *   124 = Modifier Relative Percent
 *   127 = Absolute Percent
 */
const PERCENT_UNIT_IDS: ReadonlySet<number> = new Set([105, 109, 111, 121, 124, 127])

/**
 * Decide whether a modifier value should be divided by 100 before the
 * operation pipeline applies it. Pyfa-aligned behaviour (verified against
 * EVE Online's actual semantics, not just SDE unit metadata):
 *
 *   - PostPercent: value is ALWAYS stored as a raw percent number
 *     (5 → "+5%"). Divide by 100 so the pipeline can apply `× (1 + value)`.
 *     Skill ship-bonus attributes routinely carry `unitID = null` yet
 *     hold raw percent — the operation's contract is the only reliable
 *     signal.
 *
 *   - PreMul / PostMul / PreDiv / PostDiv: value is a LITERAL multiplier
 *     (0.5 → "× 0.5", 2.5 → "× 2.5"), regardless of whether the SDE
 *     attribute is tagged with a percent unit. Concrete example: the
 *     Compact Interdiction Nullifier carries effect 2645 (PostMul on
 *     scan resolution via attr 565 with unit 109 "%" and value 0.5);
 *     the intent is "× 0.5" not "+0.5%". Dividing by 100 here would
 *     reduce scan res to 0.5% of base — catastrophic.
 *
 *   - PreAssign / PostAssign / ModAdd / ModSub: pass through literally.
 *     Skill-driven percentage modifiers reach this branch through
 *     PostPercent, never through these.
 *
 * Returns the value as the pipeline expects to consume it.
 */
function scaleForPipeline(
    rawValue: number,
    _unitID: number | undefined,
    op: ModifierOperation,
): number {
    // _unitID is intentionally ignored — kept in the signature for callers
    // that read attribute metadata for other reasons; the actual scaling
    // decision is op-driven.
    if (op === 'PostPercent') return rawValue / 100
    return rawValue
}

/**
 * Apply every modifier of every effect on a single source item. Effects are
 * filtered by the item's current state (only effects active at the current
 * state contribute). EffectStopper modifiers are NOT applied here — see
 * `collectEffectStoppers()` for that.
 */
export function applySourceItem(
    source: ItemState,
    ctx: FitContext,
    dataset: FittingDataset,
): void {
    const isLocalModule = source.kind === 'module'
    // Two-phase application: a source's SELF modifiers (domain itemID — the item
    // modifying its own attributes) must run BEFORE its OUTGOING modifiers that
    // READ those attributes. Example: an Assault Damage Control's active effect
    // (7012) PostAssigns the item's own resist-multiplier attrs (974-977) to the
    // "activated" value (0.25), and its passive effect (2302) then reads 974 to
    // multiply the ship's hull resonance. Applying 2302 before 7012 reads the
    // un-activated 0.75 → ~half the real resist. Self-first matches eos's lazy
    // attribute resolution.
    const selfMods: Array<{ effect: SdeEffect; mi: SdeModifierInfo }> = []
    const outMods: Array<{ effect: SdeEffect; mi: SdeModifierInfo }> = []
    for (const eid of source.effectIDs) {
        // Effects claimed by hardcoded handlers (e.g. T3C subsystem
        // "*AddPassive" HP bonuses) must NOT be re-applied here, or the
        // bonus would be double-counted.
        if (LEGACY_HANDLED_EFFECT_IDS.has(eid)) continue
        // Pilot-security-status-scaled bonuses (Alliance-Tournament frigates:
        // Sidewinder/Cambion/Whiptail/…). Pyfa computes `bonus = attr ×
        // pilotSecStatus`, and the default character has sec status 0, so the
        // bonus is 0. We don't model pilot security status, so applying the raw
        // attribute (e.g. ATFrigDmgBonus = -7.5 %) wrongly dents weapon DPS.
        // Treat these as no-ops, matching pyfa's default-pilot behaviour.
        if (SEC_STATUS_SCALED_EFFECT_IDS.has(eid)) continue
        // Pyfa-parity: a projected warp scrambler / disruptor stops effects
        // 6441 (MWD) and 6442 (MJD) on the target. When the local fit IS
        // the target (the user has projected hostile scram onto themselves
        // via the Projected panel), the corresponding local module effect
        // doesn't fire. Other local items (drones, fighters, implants)
        // are out of scope for ship-mounted prop modules.
        if (isLocalModule && ctx.stoppedLocalEffectIDs.has(eid)) continue
        const effect = dataset.effects.get(eid)
        if (!effect) continue
        if (!source.appliesAtState(effect)) continue
        for (const mi of effect.modifierInfo) {
            (mi.domain === 'itemID' ? selfMods : outMods).push({ effect, mi })
        }
    }
    for (const { effect, mi } of selfMods) applyOneModifier(source, effect, mi, ctx, dataset)
    for (const { effect, mi } of outMods) applyOneModifier(source, effect, mi, ctx, dataset)
}

/**
 * Walk the projected sources currently in scope and collect every effect
 * ID that an `EffectStopper` modifierInfo entry suppresses on the target.
 * Returns the union of all stopped IDs — typically a tiny Set (warp scram
 * carries 2 stoppers: MWD effect 6441 + MJD effect 6442).
 *
 * Only EffectStopper entries with `domain: 'target'` are honored, because
 * they semantically apply to the receiving ship (= our local fit when the
 * user has projected hostile sources onto themselves). Entries scoped to
 * `self` / `itemID` would suppress the stopper-source's OWN effects, which
 * isn't a Pyfa-modeled scenario.
 *
 * The projected source must be in `ACTIVE` (or `OVERLOAD`) state — an
 * offline scram doesn't suppress anything.
 */
export function collectEffectStoppers(
    projectedSources: readonly ItemState[],
    dataset: FittingDataset,
): Set<number> {
    const out = new Set<number>()
    for (const src of projectedSources) {
        if (src.state !== 'ACTIVE' && src.state !== 'OVERLOAD') continue
        for (const eid of src.effectIDs) {
            const effect = dataset.effects.get(eid)
            if (!effect) continue
            // Module-level scram/disruptor: SDE carries EffectStopper modInfo.
            for (const mi of effect.modifierInfo) {
                if (mi.func !== 'EffectStopper') continue
                if (mi.domain !== 'target') continue
                if (typeof mi.effectID !== 'number') continue
                out.add(mi.effectID)
            }
            // Fighter abilities: SDE modifierInfo is empty for fighter
            // scram/tackle (effects 6436, 6464). Pyfa-parity hardcodes the
            // stopper semantics: a fighter warp-disrupting / tackling its
            // target prevents the target's MWD (effect 6441) and MJD
            // (effect 6442) from running, identical to module scram.
            if (eid === 6436 || eid === 6464) {
                out.add(6441)
                out.add(6442)
            }
        }
    }
    return out
}

// =============================================================================
// Fighter projection abilities — empty modifierInfo in SDE because each
// ability is hardcoded in Pyfa as a dedicated `effects.py` class. These
// fire during the projection pass when an enemy fighter squadron is added
// as a Projected Source.
//
// Coverage in this module:
//   - 6435 fighterAbilityStasisWebifier — apply speedPenalty as PostPercent
//     on ship.maxVelocity (attr 37). Same shape as module web (effect 6426).
//   - 6434 fighterAbilityEnergyNeutralizer — emit a NEUT entry into
//     `projectionReports`, draining cap per-second on the receiver.
//
// Scram/tackle (6436 / 6464) are NOT handled here: they're modeled via the
// EffectStopper pre-pass, which adds 6441 (MWD) + 6442 (MJD) to
// `ctx.stoppedLocalEffectIDs`. ECM (6437), bombs (6485), Kamikaze (6554)
// and MJD self-effect (6442) remain OUT_OF_SCOPE — see constants.ts.
// =============================================================================

const ATTR_FIGHTER_WEB_SPEED_PEN  = 2184
const ATTR_FIGHTER_NEUT_DURATION  = 2208
const ATTR_FIGHTER_NEUT_AMOUNT    = 2211
const ATTR_MAX_VEL                = 37

export interface FighterProjectionReport {
    typeID: number
    kind: 'NEUT'
    /** Per-second cap drain (positive = drain on receiver). */
    perSecond: number
    summary: string
}

/** Apply a single fighter source's projection abilities. Called after the
 *  generic projection-EWAR pass in the engine; the source must be in
 *  ACTIVE / OVERLOAD state. Returns any drain/jam-style ability reports
 *  the engine should append to `derived.projected[]` for UI rendering. */
export function applyLegacyFighterProjection(
    fighter: ItemState,
    ctx: FitContext,
): FighterProjectionReport[] {
    const reports: FighterProjectionReport[] = []
    if (fighter.state !== 'ACTIVE' && fighter.state !== 'OVERLOAD') return reports

    // Stasis Webifier — PostPercent slowdown on ship maxVelocity. Pyfa
    // applies the speedPenalty (negative number, e.g. -50) as PostPercent
    // converted to a fraction (-0.5 → × 0.5).
    if (fighter.effectIDs.has(6435)) {
        const pen = fighter.getFinal(ATTR_FIGHTER_WEB_SPEED_PEN, 0)
        if (pen !== 0) {
            ctx.ship.addAffliction(ATTR_MAX_VEL, {
                sourceKind: 'fighter',
                sourceID: fighter.id,
                operation: 'PostPercent',
                value: pen / 100,
                stackingGroup: `attr:${ATTR_MAX_VEL}`,
            })
        }
    }

    // Energy Neutralizer — per-second cap drain. Ability `Amount` is GJ
    // per cycle; `Duration` is cycle ms. Same shape as the module variant
    // surfaced by `buildCapWarfareReport`.
    if (fighter.effectIDs.has(6434)) {
        const amount = fighter.getFinal(ATTR_FIGHTER_NEUT_AMOUNT, 0)
        const durMs  = fighter.getFinal(ATTR_FIGHTER_NEUT_DURATION, 0)
        if (amount > 0 && durMs > 0) {
            const perSecond = amount / (durMs / 1000)
            reports.push({
                typeID: fighter.typeID,
                kind: 'NEUT',
                perSecond,
                summary: `Fighter cap drain: ${perSecond.toFixed(1)} GJ/s`,
            })
        }
    }

    return reports
}

/**
 * Apply a single modifier descriptor. Pulled out for testability and so the
 * top-level engine can call it directly when applying skill effects through
 * the character item (which exposes effects through its skill book typeIDs).
 */
export function applyOneModifier(
    source: ItemState,
    effect: SdeEffect,
    mi: SdeModifierInfo,
    ctx: FitContext,
    dataset: FittingDataset,
): void {
    if (mi.func === 'EffectStopper') return  // handled elsewhere

    const op = mi.operation === undefined ? 'PostMul' : OPERATION_BY_SDE_CODE[mi.operation]
    if (!op) return  // unknown opcode → skip rather than crash

    if (mi.modifiedAttributeID === undefined) return

    const computed = computeModifierValue(source, mi, ctx, dataset, op)
    if (computed === null) return

    const targets = ctx.targetsForModifier(mi, source)
    if (targets.length === 0) return

    const stackingGroup = computeStackingGroup(source, mi, dataset, effect)

    // Multiplicative ops carry a literal multiplier in the SDE
    // (e.g. attr 565 = 0.5 + PostMul → "× 0.5"). The only exception is
    // SKILL-SCALED modifiers: per-level skill bonuses are stored
    // fractionally (e.g. +5%/level → 0.05/level), so after scaling by
    // skill level the value is a fractional bonus that the pipeline must
    // see as `1 + bonus` to combine multiplicatively. `computed.scaled`
    // tells us whether the value passed through level-scaling — when
    // false, the value is a literal multiplier (e.g. cloak CPU bonus
    // attr_649 = 0 means "× 0", NOT "× 1"). PostPercent always wraps in
    // the pipeline regardless.
    const isMul = op === 'PreMul' || op === 'PostMul' || op === 'PreDiv' || op === 'PostDiv'
    const value = (isMul && computed.scaled) ? (1 + computed.value) : computed.value

    // For multiplicative ops the target attribute MUST seed its base from
    // the SDE `defaultValue` — otherwise a target without that attr in its
    // typeDogma row gets seed 0, and `0 × multiplier = 0` collapses what
    // should be a 1× pass-through (e.g. `missileDamageMultiplier` defaults
    // to 1 in the SDE; a Caldari Navy Scourge LM doesn't list attr_212
    // explicitly, so a BCS PreMul × 1.1 must apply against 1, not 0).
    const sdeDefault = isMul
        ? (dataset.attributes.get(mi.modifiedAttributeID)?.defaultValue ?? 0)
        : 0

    for (const target of targets) {
        const affliction: ModifierAffliction = {
            sourceKind: mapSourceKind(source.kind),
            sourceID: source.id,
            operation: op,
            value,
            stackingGroup,
            resistanceAttributeID: effect.resistanceAttributeID,
        }
        target.addAffliction(mi.modifiedAttributeID, affliction, sdeDefault)
    }
}

/**
 * Compute the numeric value the modifier contributes. For most modifiers
 * this is just the value of `modifyingAttributeID` on the source item; for
 * skill modifiers it's `value × skill_level`.
 *
 * Returns null when the modifier can't be applied (missing attribute, etc.).
 *
 * Unit-based scaling: SDE attributes whose unitID flags them as a percent
 * (105/109/111/121/124/127) are stored as raw percent numbers — e.g.
 * `damageMultiplierBonus = 5` means "+5%". The engine divides by 100 so
 * the operation pipeline can treat the value as a fractional bonus
 * (`PostPercent: × (1 + 0.05)` instead of the broken `× (1 + 5)`).
 */
/**
 * T3C subsystem bonus attribute → racial sub-skill mapping. Pyfa hardcodes
 * skill scaling by the corresponding "<Race> <Role> Systems" skill in its
 * effect handlers (e.g. effect 4360 carries `skill='Amarr Offensive
 * Systems'`). The SDE's `modifierInfo` for these LocationGroup /
 * LocationModifier entries lacks `skillTypeID`, so without explicit
 * scaling the bonus is taken at face value (-5 % per stack instead of
 * -25 % at skill V).
 *
 * Verified against:
 *   - `https://raw.githubusercontent.com/pyfa-org/Pyfa/master/eos/effects.py`
 *     (each subsystem bonus effect's `skill='<Race> <Role> Systems'` arg)
 *   - SDE attribute names matching `subsystemBonus<Race><Role>` (attr IDs
 *     1431-1450 and 1507+ family).
 */
/**
 * Ship hull bonus attribute → racial class-skill mapping. Covers BOTH:
 *   (a) capital hulls (Carrier / FAX / Supercarrier / Dreadnought / Titan /
 *       Lancer Dread / Drifter Battlecruiser) where the SDE describes the
 *       attrs as "Multiplied by <Race> <Class> skill level"; and
 *   (b) sub-capital hulls — every racial frigate / cruiser / battleship
 *       (skills 3328-3339) whose hull bonuses follow the SAME shape: an
 *       on-skill effect `dom=shipID target=<attr> source=280 op=PreMul`
 *       that, in Pyfa, scales the target ship attribute by the skill level
 *       at the SHIP-side reader (the per-skill-class ItemModifier /
 *       LocationRequiredSkillModifier downstream).
 *
 * Why this single map handles both, and why the level scaling lives HERE
 * (computeModifierValue) instead of in `applySkills`:
 *
 *   The SDE `source=280 (skillLevel) op=PreMul` shape literally says
 *   "multiply by skillLevel" — but the per-level value lives on the SKILL
 *   type as attr 280 = 0 (a placeholder). Reading 0 in `applySkills`
 *   collapses the modifier to a no-op (`1 + 0 × level = 1`). Two ways to
 *   fix it conceptually:
 *
 *     (i)  Substitute `value = level` in `applySkills` so ship.attr is
 *          truly pre-multiplied by skillLevel. Then the ship-side reader
 *          does NOT scale by level again. — But the ship-side reader on
 *          sub-cap hulls is `LocationRequiredSkillModifier skillTypeID=X`
 *          (with X = e.g. Large Projectile Turret), which currently scales
 *          by `level` via the "skillTypeID is not source's required skill"
 *          path. We'd have to re-detect "this attr was already pre-scaled,
 *          don't scale again" → fragile metadata tracking on attribute
 *          values, OR a parallel "skip level scaling for these attrs in
 *          LRSM" set that mirrors this map. Either way, just as much
 *          enumeration and more chances to miss a path.
 *
 *     (ii) Leave the `applySkills` PreMul as a no-op (current behaviour)
 *          AND register every "multiplied by skill level" target attr
 *          here. Then the ship-side reader (whether ItemModifier or LRSM)
 *          gets the `× level` it needs in ONE place via this map — no
 *          double-counting risk because applySkills' PreMul step doesn't
 *          actually multiply.
 *
 *   We use (ii). Critically, do NOT reintroduce a generic `value = level`
 *   substitution in `applySkills` alongside this map — that DOES
 *   double-scale: capital resonances clamp to 100 % → infinite EHP, and
 *   sub-cap weapon ROFs flip negative → 0 DPS. See
 *   feedback_caldari_bs_skill_premul.md.
 *
 * Naming convention for capital attrs: `shipBonus<Class><Race>N` where
 * Race ∈ {A,C,G,M}. For sub-caps the attrs follow various legacy names but
 * the SDE always exposes them through the eff dump for skills 3328-3339.
 */
const SHIP_BONUS_SCALING_SKILL: ReadonlyMap<number, number> = new Map([
    // ----- Capital hulls -----
    // Carrier (A1-A4 + A5)
    [2359, 24311], [2360, 24311], [2361, 24311], [2362, 24311], [5981, 24311],
    [2363, 24312], [2364, 24312], [2365, 24312], [2366, 24312], [5982, 24312],
    [2367, 24313], [2368, 24313], [2369, 24313], [2370, 24313], [5983, 24313],
    [2371, 24314], [2372, 24314], [2373, 24314], [2374, 24314], [5984, 24314],
    // ForceAuxiliary (same Carrier skills)
    [2308, 24311], [2309, 24311], [2310, 24311], [2320, 24311], [6114, 24311],
    [2311, 24312], [2312, 24312], [2313, 24312], [2321, 24312], [6113, 24312],
    [2314, 24313], [2315, 24313], [2316, 24313], [2322, 24313], [6112, 24313],
    [2317, 24314], [2318, 24314], [2319, 24314], [2323, 24314], [6116, 24314],
    // Supercarrier (same Carrier skills, A1-A5)
    [2375, 24311], [2376, 24311], [2377, 24311], [2378, 24311], [2379, 24311],
    [2380, 24312], [2381, 24312], [2382, 24312], [2383, 24312], [2384, 24312],
    [2385, 24313], [2386, 24313], [2387, 24313], [2388, 24313], [2389, 24313],
    [2390, 24314], [2391, 24314], [2392, 24314], [2393, 24314], [2394, 24314],
    // Dreadnought (A1-A4)
    [2283, 20525], [2284, 20525], [2285, 20525], [5214, 20525],
    [2286, 20530], [2287, 20530], [2288, 20530],
    [2289, 20531], [2290, 20531], [2291, 20531], [5215, 20531], [5216, 20531],
    [2292, 20532], [2293, 20532], [2294, 20532], [5248, 20532],
    // Lancer Dreadnoughts (Advanced Dreadnought)
    [5417, 77738], [5418, 77738],
    // Triglavian / Precursor Dreadnought (Zirnitra) — skill 52997 PreMuls
    // attrs 2829 (PC2 armor resists, ship-side ItemModifier effect 7239),
    // 2830 (PC1 weapon damage cap, ship-side LRSM effect 7238 with the
    // Capital Precursor Weapon skill as a target FILTER not the scaler)
    // and 2831 (PC3 weapon speed, ship-side LRSM effect 7240, same).
    // Without these, Zirnitra's +20% armor resists (-4 × 5) collapses to
    // -4% and armor EHP underreports by ~17% under RAH+Uniform damage.
    [2829, 52997], [2830, 52997], [2831, 52997],
    // Expedition Command Ships (Odysseus / Drifter Battlecruiser)
    [795, 89609], [1889, 89609], [5205, 89609],  // shipBonusABC1/ABC2/ABC3
    // Titan (A1-A4 + C5)
    [2406, 3347], [2407, 3347], [2408, 3347], [2409, 3347],
    [2410, 3346], [2411, 3346], [2412, 3346], [2413, 3346], [2423, 3346],
    [2414, 3344], [2415, 3344], [2416, 3344], [2417, 3344],
    [2418, 3345], [2419, 3345], [2420, 3345], [2421, 3345],

    // ----- Sub-capital racial hulls -----
    // Enumerated from a SDE walk: every effect on skills 3328-3339 with
    // `dom=shipID source=280 op=PreMul` writes to one of these target
    // attributes. The ship-side reader of each target attr gets the
    // `× level` from the LRSM "non-required-skill" path or this map's
    // ship-source ItemModifier path.
    // Gallente Frigate (3328)
    [462, 3328], [586, 3328], [1625, 3328],
    // Minmatar Frigate (3329)
    [460, 3329], [587, 3329], [1626, 3329],
    // Caldari Frigate (3330)
    [463, 3330], [588, 3330], [1624, 3330],
    // Amarr Frigate (3331)
    [464, 3331], [485, 3331], [1623, 3331],
    // Gallente Cruiser (3332)
    [486, 3332], [658, 3332], [2014, 3332],
    // Minmatar Cruiser (3333)
    [489, 3333], [659, 3333], [5747, 3333],
    // Caldari Cruiser (3334)
    [487, 3334], [657, 3334], [1535, 3334],
    // Amarr Cruiser (3335)
    [478, 3335], [656, 3335], [2070, 3335],
    // Gallente Battleship (3336)
    [500, 3336], [561, 3336], [5240, 3336],
    // Minmatar Battleship (3337)
    [490, 3337], [518, 3337],
    // Caldari Battleship (3338)
    [491, 3338], [501, 3338], [598, 3338],
    // Amarr Battleship (3339)
    [585, 3339], [5960, 3339],

    // ----- Logistics Cruisers (T2 logi + navy variants) -----
    // Effects 1033/1034/1035/1036 (Remote Armor / Shield Transfer Cap Need)
    // and 1181/1183 (Energy Transfer Cap Need) declare LRSM with
    // skillTypeID=Remote Armor Repair Systems / Shield Emission Systems /
    // [LocationGroupModifier on Remote Capacitor Transmitter] — but those
    // skills are FILTERS for which target modules receive the bonus, not
    // the per-level scalar. Pyfa hardcodes `skill='Logistics Cruisers'`
    // (12096) on every one of these handlers (effects.py Effect1033 etc.).
    // Without this map entry the ship-side reader stays at the flat -15%
    // value declared on the hull and the cap-need bonus never reaches
    // Pyfa's -75% at All-V. Affects Guardian / Basilisk / Oneiros /
    // Scimitar / Etana / Rabisu / Zarmazd. Closes the Legion fixture's
    // skipped cap-stable assertion (Pyfa 38.8% stable with Logi mode).
    [678, 12096], [679, 12096],

    // ----- Logistics Frigates (T2 logi frigs) -----
    // Effects 6377/6378 (Armor / Shield Rep Speed + Cap) and 6379/6380/6381
    // (Armor HP / Shield HP / Sig). Same pattern: LRSM `skillTypeID` is the
    // filter, Pyfa hardcodes `skill='Logistics Frigates'` (40328). Affects
    // Deacon / Kirin / Thalia / Scalpel.
    [2092, 40328], [2093, 40328],

    // ----- Industrial / Hauler racial hulls (skills 3340-3343) -----
    // Sub-cap haulers carry per-level bonus attrs scaled by the racial
    // hauler skill. Each skill PreMul-scales attrs holding the per-level
    // value, then a downstream ItemModifier or LRSM consumes them. Not
    // typically tested in our parity suite but their absence under-reports
    // hauler agility / cargo / shield bonuses on partial-skills profiles.
    [493, 3341], [814, 3341], [3157, 3340], [3241, 3340], // Minmatar/Gallente Hauler
    [494, 3343], [809, 3343],                              // Amarr Hauler
    [495, 3342], [811, 3342],                              // Caldari Hauler
    [496, 3340], [813, 3340],                              // Gallente Hauler

    // ----- Sub-cap racial Destroyer hulls (skills 33091-33094) -----
    // Same pattern. Effect catalog enumerated from a SDE walk.
    [1887, 33091], [1888, 33091], [5218, 33091], [5219, 33091],
    [5220, 33091], [5221, 33091], [5222, 33091],            // Amarr Destroyer
    [734, 33092], [735, 33092], [5225, 33092], [5228, 33092], [5229, 33092],  // Caldari Destroyer
    [738, 33093], [739, 33093], [5230, 33093], [5232, 33093], [5233, 33093],  // Gallente Destroyer
    [729, 33094], [740, 33094], [5235, 33094], [5236, 33094], [5237, 33094],  // Minmatar Destroyer

    // ----- Sub-cap racial Battlecruiser hulls (skills 33095-33098) -----
    // Drake / Hurricane / Harbinger / Brutix all use these. Note attrs
    // 795/1889/5205 are ALSO Amarr-BC bonuses but the Drifter Expedition
    // Command Ship (Odysseus) reads them via skill 89609 — see the
    // Expedition Command Ships entry above. Map duplicate keys overwrite,
    // last-wins, so the Drifter mapping wins for Odysseus while Amarr BC
    // hulls (Harbinger / Prophecy) carry skill 33095 as well.
    [743, 33096], [745, 33096], [5044, 33096],             // Caldari Battlecruiser
    [746, 33097], [747, 33097], [5046, 33097],             // Gallente Battlecruiser
    [748, 33098], [749, 33098], [5207, 33098],             // Minmatar Battlecruiser

    // ----- T2 sub-cap class skill hulls -----
    // Interceptors (12092), Covert Ops (12093), Assault Frigates (12095),
    // Heavy Assault Cruisers (16591), Transport Ships (19719), Recon Ships
    // (22761), Command Ships (23950), Interdictors (12098), Heavy
    // Interdiction Cruisers (28609), Electronic Attack Ships (28615),
    // Black Ops (28656), Marauders (28667), Logistics Frigates (40328 —
    // already partially mapped above), Logistics Cruisers (12096 — already
    // partially mapped above), Industrial Command Ships (29637).
    [568, 12092], [804, 12092],                            // Interceptors
    [569, 12093], [839, 12093], [1578, 12093], [2731, 12093],  // Covert Ops
    [673, 12095], [675, 12095],                            // Assault Frigates
    [692, 16591], [693, 16591],                            // Heavy Assault Cruisers
    [807, 19719], [808, 19719], [1360, 19719], [1361, 19719],  // Transport Ships
    [962, 22761], [963, 22761], [1537, 22761],             // Recon Ships
    [999, 23950], [1000, 23950], [1924, 23950], [5772, 23950],  // Command Ships
    [1012, 12098], [1013, 12098],                          // Interdictors
    [1246, 28609], [1247, 28609],                          // Heavy Interdiction Cruisers
    [1249, 28615], [1250, 28615], [2069, 28615],           // Electronic Attack Ships
    [1257, 28656], [1258, 28656], [2627, 28656], [2628, 28656],  // Black Ops
    [1265, 28667], [1266, 28667],                          // Marauders
    [5792, 12096], [2460, 12096],                          // Logistics Cruisers (extra attrs beyond 678/679)

    // ----- Capital Industrial / Freighter / ORE Freighter / Industrial
    // ----- Command Ships -----
    [886, 20524], [887, 20524],                            // Amarr Freighter
    [888, 20526], [889, 20526],                            // Caldari Freighter
    [890, 20527], [891, 20527],                            // Gallente Freighter
    [892, 20528], [893, 20528],                            // Minmatar Freighter
    [1239, 28374], [1240, 28374], [1243, 28374], [1244, 28374],
    [2582, 28374], [3233, 28374],                          // Capital Industrial Ships (Rorqual)
    [1311, 29029], [1312, 29029],                          // Jump Freighters
    [1356, 29637], [1358, 29637], [2474, 29637], [2475, 29637],
    [2577, 29637], [3211, 29637], [3212, 29637], [3235, 29637],  // Industrial Command Ships (Orca / Porpoise)
    [1983, 34327], [1984, 34327],                          // ORE Freighter (Bowhead)
    [5647, 81032], [5648, 81032],                          // Upwell Hauler
    [5649, 81044], [5650, 81044], [5654, 81044],           // Upwell Freighter

    // ----- T3 (Tactical) Destroyers (skills 34390/34533/35680/35685) -----
    // Bonus attrs on the hull, racial T3D skill scales them.
    [1986, 34390], [1987, 34390], [1988, 34390],           // Amarr Tactical Destroyer (Confessor)
    [2004, 34533], [2005, 34533], [2006, 34533],           // Minmatar Tactical Destroyer (Svipul)
    [2015, 35680], [2016, 35680], [2017, 35680],           // Caldari Tactical Destroyer (Jackdaw)
    [2027, 35685], [2028, 35685], [2029, 35685],           // Gallente Tactical Destroyer (Hecate)

    // ----- Command Destroyers (skill 37615) -----
    // Eight T2 destroyer hulls. eliteBonusCommandDestroyer1/2/3.
    [2059, 37615], [2060, 37615], [2061, 37615],

    // ----- Strategic Cruiser (T3C) racial-hull skill scaling for hull
    // ----- attrs that are NOT subsystem attrs. Distinct from the per-
    // ----- subsystem map. -----
    [1503, 30650], [2677, 30650],                          // Amarr Strategic Cruiser
    [1504, 30651], [2676, 30651],                          // Caldari Strategic Cruiser
    [1505, 30652], [2678, 30652],                          // Gallente Strategic Cruiser
    [1506, 30653], [2679, 30653],                          // Minmatar Strategic Cruiser

    // ----- T3C subsystem cross-skill bonus attrs (subsystem-skill scaled
    // ----- but not in the SUBSYSTEM_BONUS_SCALING_SKILL map because they
    // ----- live at the SHIP attribute layer, not the subsystem). Source
    // ----- check is done via the ship-source guard which works for these. -----
    [1517, 30540], [1519, 30546], [1520, 30553], [1521, 30550], // Gallente sub-skills (Defensive/Core/Propulsion/Offensive)
    [1522, 30551], [1523, 30554], [1525, 30547], [1526, 30545], // Minmatar
    [1531, 30537], [1532, 30550], [1533, 30549], [1534, 30551], // racial offensive cross-faction
    [2680, 30532], [2681, 30539], [2682, 30544], [2683, 30548], // racial defensive/core
    [2684, 30540], [2685, 30546], [2686, 30545], [2687, 30547],

    // ----- Triglavian / Precursor Frigate / Cruiser / BS / Destroyer / BC -----
    // shipBonusPC1/PC2 (Cruiser), PF1/PF2 (Frigate), PBS1/PBS2 (BS), PD1/PD2 (Destroyer), PBC1/PBC2 (BC)
    [2762, 47867], [2763, 47867],                          // Precursor Frigate (Damavik)
    [2764, 47868], [2765, 47868],                          // Precursor Cruiser (Vedmak)
    [2766, 47869], [2767, 47869],                          // Precursor Battleship (Leshak)
    [2799, 49742], [2800, 49742],                          // Precursor Destroyer (Kikimora)
    [2801, 49743], [2802, 49743],                          // Precursor Battlecruiser (Drekavac)

    // ----- EDENCOM hulls (Vorton Projector ships) -----
    [3041, 55031], [3042, 55031],                          // EDENCOM Frigate
    [3043, 55032], [3044, 55032],                          // EDENCOM Cruiser
    [3045, 54794], [3046, 54794],                          // EDENCOM Battleship

    // ----- Mining Barge / Exhumers / Expedition Frigates / Mining Destroyer -----
    [3201, 22551], [3202, 22551], [3226, 22551],           // Exhumers (Hulk/Mackinaw/Skiff)
    [3213, 33856], [3214, 33856],                          // Expedition Frigates (Prospect/Endurance)
    [5820, 89241],                                         // Mining Destroyer (Mindflood / Venture-class)

    // ----- Misc -----
    [2752, 47445],  // Flag Cruisers (Monitor)
    [5681, 83094], // conduitPassengerBonusPercent (Capital Jump Portal Generation)

    // ----- Mining Destroyer (Hatchet) — skill 89241 -----
    [5821, 89241], [5822, 89241], [5953, 89241],

    // ----- Mining Frigate (Venture-class) — skill 32918 -----
    [5955, 32918],

    // ----- Caldari Battlecruiser extra attr 5956 -----
    [5956, 33096],

    // ----- Expedition Command Ships extra attrs 5939-5943 (Odysseus / Cenotaph variants) -----
    [5939, 89609], [5940, 89609], [5941, 89609], [5942, 89609], [5943, 89609],

    // ----- Amarr Battleship extra attr 5960 -----
    [5960, 3339],

    // ----- Capital Carrier extra attrs (5981-5984 = Carrier role drone bonus,
    // 6112-6116 = same skill-driven attrs on the FAX side, all per racial Carrier skill).
    [5981, 24311], [5982, 24312], [5983, 24313], [5984, 24314],
    [6112, 24313], [6113, 24312], [6114, 24311], [6116, 24314],

    // ----- Auto-derived from the SDE: attrs that are BOTH skill-level-scaled
    // (a skill effect does `attr ×= skillLevel` via attr 280) AND read by a
    // SHIP-side effect as the bonus value. These are per-racial/role-skill hull
    // bonuses whose ship-side reader must scale by the skill level. Previously
    // missing → the bonus was taken at base (×1) instead of ×5 at All-V.
    // Notable: Exhumer/Barge shield+armor resist role bonuses (Hulk/Skiff/
    // Mackinaw shield resist 4 %→20 %), Bhaalgorn drone+laser (492), industrial
    // command (Orca/Rorqual), Marauder/pirate/expedition hull bonuses.
    [66, 89611], [310, 3432], [349, 19760], [492, 3339], [1296, 21610],
    [1669, 3184], [1670, 3184], [1842, 32918], [3167, 33856],
    [3181, 17940], [3182, 17940], [3183, 17940], [3184, 17940], [3185, 17940],
    [3187, 17940], [3188, 17940], [3190, 33856], [3191, 33856], [3192, 33856],
    [3193, 22551], [3194, 22551], [3197, 22551], [3198, 22551], [3199, 22551],
    [3203, 29637], [3204, 29637], [3205, 29637], [3210, 3341], [3221, 29637],
    [3222, 29637], [3223, 28374], [3224, 28374], [3237, 32918], [3240, 32918],
    [3326, 28374], [6088, 33092], [6089, 33094],
])

const SUBSYSTEM_BONUS_SCALING_SKILL: ReadonlyMap<number, number> = new Map([
    // Amarr
    [1431, 30539], [1509, 30539],  // AmarrCore → Amarr Core Systems
    [1432, 30536], [1508, 30536],  // AmarrElectronic
    [1433, 30532], [1507, 30532],  // AmarrDefensive
    [1434, 30537], [1511, 30537],  // AmarrOffensive
    [1435, 30538], [1512, 30538],  // AmarrPropulsion
    // Caldari
    [1441, 30548], [1515, 30548],  // CaldariCore
    [1442, 30542], [1514, 30542],  // CaldariElectronic
    [1443, 30544], [1516, 30544],  // CaldariDefensive
    [1444, 30549], [1510, 30549],  // CaldariOffensive
    [1445, 30552], [1513, 30552],  // CaldariPropulsion
    // Gallente
    [1436, 30546],                 // GallenteCore
    [1437, 30541],                 // GallenteElectronic
    [1438, 30540],                 // GallenteDefensive
    [1439, 30550],                 // GallenteOffensive
    [1440, 30553],                 // GallentePropulsion
    // Minmatar
    [1446, 30547],                 // MinmatarCore
    [1447, 30543],                 // MinmatarElectronic
    [1448, 30545],                 // MinmatarDefensive
    [1449, 30551],                 // MinmatarOffensive
    [1450, 30554],                 // MinmatarPropulsion

    // ----- Authoritative completion: every subsystem-bonus attr that the SDE
    // ----- scales by a racial subsystem skill, derived verbatim from the
    // ----- `subsystemSkillLevel*` skill effects (modAttr = bonus attr,
    // ----- modifying = 280/skillLevel, PreMul). The Amarr/Caldari secondaries
    // ----- above were hand-added; Gallente + Minmatar secondaries (and the
    // ----- 2680-2687 defensive/core block) were MISSING, so subsystem-sourced
    // ----- bonuses on those races (e.g. Loki Propulsion agility 1523, Offensive
    // ----- RoF 1522 / 1534) fell to the flat path and applied ×1 instead of ×5.
    // ----- Duplicates of the entries above are harmless (same value).
    [1517, 30540], [1519, 30546], [1520, 30553], [1521, 30550], // Gallente Def/Core/Prop/Off secondaries
    [1522, 30551], [1523, 30554], [1525, 30547], [1526, 30545], // Minmatar Off/Prop/Core/Def secondaries
    [1531, 30537], [1532, 30550], [1533, 30549], [1534, 30551], // Off cross-race tertiaries (Amarr/Gallente/Caldari/Minmatar)
    [2680, 30532], [2681, 30539], [2682, 30544], [2683, 30548], // Def/Core extra (Amarr/Caldari)
    [2684, 30540], [2685, 30546], [2686, 30545], [2687, 30547], // Def/Core extra (Gallente/Minmatar)
])

/** Result of {@link computeModifierValue}. `scaled=true` means the value
 *  was multiplied by a skill level (per-level fractional bonus); `scaled=false`
 *  means the value is a literal multiplier from the SDE. The wrap-as-`1+x`
 *  shortcut in `applyOneModifier` only applies when scaled=true. */
interface ComputedModifierValue {
    value: number
    /** True when the value passed through skill-level scaling (× level).
     *  False for ItemModifier-style direct attribute reads and for FLAT
     *  LRSM/ORSM paths (DDA, subsystem cloak CPU, ship role bonuses). */
    scaled: boolean
}

function computeModifierValue(
    source: ItemState,
    mi: SdeModifierInfo,
    ctx: FitContext,
    dataset: FittingDataset,
    op: ModifierOperation,
): ComputedModifierValue | null {
    if (mi.modifyingAttributeID === undefined) return null

    // Source value: read FROM the item carrying the effect. We use the
    // FULLY-MODIFIED value (not the SDE base) so chained modifiers compose
    // correctly — e.g. EM Armor Compensation V boosts the EANM's
    // `emDamageResistanceBonus` (attr 984) from -20 to -25, and the
    // EANM's resonance effect must read the boosted -25, not the base
    // -20. Pyfa's eos uses `getModifiedItemAttr()` for the same reason.
    //
    // Use `attrs.has` to distinguish "attribute not on this type" (return
    // null, modifier inactive) from "attribute is on this type but
    // computes to 0" (legitimate value). `getFinal` returns 0 for both
    // cases so we can't rely on it alone.
    if (!source.hasAttr(mi.modifyingAttributeID)) return null
    const rawBase = source.getFinal(mi.modifyingAttributeID)

    const sourceAttr = dataset.attributes.get(mi.modifyingAttributeID)
    const baseValue = scaleForPipeline(rawBase, sourceAttr?.unitID, op)

    // T3C SUBSYSTEM SKILL SCALING (Pyfa-parity, not in SDE's modifierInfo):
    // when the source is a subsystem, two semantically distinct cases exist:
    //
    //   A. `modifyingAttributeID` is a `subsystemBonus<Race><Role>` attr:
    //      value is per-level, scale by the racial Strategic Cruiser sub-skill
    //      (Amarr Offensive Systems for `subsystemBonusAmarrOffensive`).
    //      This applies whether the modifierInfo func is ItemModifier,
    //      LocationGroupModifier, or LocationRequiredSkillModifier — the
    //      `skillTypeID` in LRSM is just a target filter, not the scaling
    //      skill (e.g. effect 4286 has skillTypeID=Remote Armor Repair Systems
    //      to filter which modules receive the bonus, but the value itself
    //      scales with Amarr Offensive Systems).
    //
    //   B. `modifyingAttributeID` is NOT a `subsystemBonus*` attr (e.g.
    //      `subsystemCommandBurstFittingReduction = -95`): value is the
    //      FULL bonus, NOT per-level. The skill in LRSM gates whether the
    //      bonus fires (level >= 1) but doesn't scale it. Without this
    //      branch, Legion's Support Processor multiplies the -95 % CPU
    //      reduction by Leadership V → -475 %, taking module CPU negative.
    if (source.kind === 'subsystem') {
        const scalingSkill = SUBSYSTEM_BONUS_SCALING_SKILL.get(mi.modifyingAttributeID)
        if (scalingSkill !== undefined) {
            const level = ctx.skillLevel(scalingSkill)
            if (level === 0) return null
            return { value: baseValue * level, scaled: true }
        }
        // Case B: source attr is NOT a per-level subsystem bonus — value is
        // FLAT. For LRSM/ORSM, the modifier's `skillTypeID` is just a
        // target-filter prerequisite; only gate on level >= 1.
        if (mi.func === 'LocationRequiredSkillModifier'
            || mi.func === 'OwnerRequiredSkillModifier') {
            if (mi.skillTypeID === undefined) return null
            if (ctx.skillLevel(mi.skillTypeID) === 0) return null
        }
        return { value: baseValue, scaled: false }
    }

    // MODULE / CHARGE / DRONE / FIGHTER / MODE source LRSM/ORSM: the modifier's
    // `skillTypeID` is a TARGET FILTER (e.g. rig drawback `drawbackCPUNeedLaunchers`
    // targets all modules requiring Missile Launcher Operation, but the rig's
    // attr_1138 = 10 is the FULL drawback at any non-zero skill level — not
    // per-level). Without this branch, our generic "scale by level" path
    // multiplied:
    //   - Small Rocket Fuel Cache rig's +10 % launcher-CPU drawback × Missile
    //     Launcher Op V → +50 % per rig.
    //   - T3D Sharpshooter Mode's `modeDamageBonusPostDiv = 0.75` × Light
    //     Missiles V → 3.75, which inverted via PostDiv into a damage
    //     REDUCTION (× 0.267) instead of the intended +33 % boost.
    if ((source.kind === 'module' || source.kind === 'charge' || source.kind === 'drone'
        || source.kind === 'fighter' || source.kind === 'mode')
        && (mi.func === 'LocationRequiredSkillModifier' || mi.func === 'OwnerRequiredSkillModifier')) {
        if (mi.skillTypeID === undefined) return null
        const level = ctx.skillLevel(mi.skillTypeID)
        if (level === 0) return null
        return { value: baseValue, scaled: false }
    }

    // SHIP HULL BONUS SKILL SCALING (Pyfa-parity, not in SDE):
    // when the source is the ship and the modifying attribute is one of
    // the known skill-scaled hull-bonus attrs (capital `shipBonus<Class>
    // <Race>N` family OR sub-cap racial frigate / cruiser / BS bonus
    // attrs), scale by the racial class skill level.
    //
    // The SDE encodes these as TWO effects:
    //   1. on the SKILL: `dom=shipID source=280 op=PreMul attr=Y` —
    //      semantic "ship.attr_Y ×= skillLevel" — but `applySkills` reads
    //      attr 280 from the skill type as 0, so this PreMul is a no-op
    //      in practice.
    //   2. on the SHIP: an ItemModifier (capitals: e.g. `shipBonusCarrier
    //      A1ArmorResists`) or LocationRequiredSkillModifier (sub-caps:
    //      e.g. `shipPTspeedBonusMB2 LRSM skillTypeID=Large Projectile
    //      Turret`) that reads attr_Y as a PostPercent on a target stat.
    //
    // For (2), we apply the `× level` HERE, at the ship-side reader, by
    // looking up Y in SHIP_BONUS_SCALING_SKILL. This is the single point
    // of truth for level scaling — DO NOT also substitute level in
    // `applySkills` step (1), or attr_Y will be scaled twice (resonance
    // → 100 % resist → infinite EHP, ROF → negative → 0 DPS).
    //
    // For LocationRequiredSkillModifier sub-cap effects, this map MUST
    // win over the generic "skillTypeID is not source's required skill →
    // scale by level" path below — otherwise the ship would scale the
    // bonus by the LRSM skill (e.g. Large Projectile Turret V) instead of
    // the racial hull skill (Minmatar Battleship V). For most racial sub-
    // cap hulls these happen to coincide (both at level 5 with All-V), but
    // a partial-skills profile would diverge silently.
    if (source.kind === 'ship') {
        const scalingSkill = SHIP_BONUS_SCALING_SKILL.get(mi.modifyingAttributeID)
        if (scalingSkill !== undefined) {
            const level = ctx.skillLevel(scalingSkill)
            if (level === 0) return null
            return { value: baseValue * level, scaled: true }
        }
    }

    if (mi.func === 'LocationRequiredSkillModifier' || mi.func === 'OwnerRequiredSkillModifier') {
        const skillID = mi.skillTypeID
        if (skillID === undefined) return null
        const level = ctx.skillLevel(skillID)
        if (level === 0) return null  // skill at 0 → modifier inactive

        // SHIP-source bonuses reaching here are FLAT, not skill-scaled. Pyfa
        // takes the value verbatim; the LRSM/ORSM `skillTypeID` only SELECTS
        // which items receive the bonus (Drones, a turret skill, Propulsion
        // Jamming, …) — it is NOT a per-level scaler. The genuinely per-level
        // racial-hull bonuses scale by their racial class skill and are handled
        // ABOVE via SHIP_BONUS_SCALING_SKILL (checked first), which is now
        // SDE-complete (auto-derived from skill `attr ×= skillLevel` effects).
        // So anything left on a ship source here is a role/special bonus whose
        // value is the FULL amount; scaling it by the selector-skill level
        // multiplied role bonuses 5× at All-V (Cobra/Orca drone +750/+500 %,
        // interceptor warp-disruptor cap need −80 %→−400 % flipping it
        // negative, Marauder weapon +500 %, Babaroga cap-need → free cap).
        // (SHIP_ROLE_BONUS_ATTRS retained below as documentation of the
        // originally-enumerated cases; this blanket rule subsumes it.)
        if (source.kind === 'ship') {
            return { value: baseValue, scaled: false }
        }

        // KEY EVE/Pyfa SEMANTIC:
        //   - When skillTypeID is one of the SOURCE'S OWN required skills,
        //     the modifier scales NOT by skill level but is FLAT — the
        //     skill is just a gating prerequisite. Example: a Drone Damage
        //     Amplifier II declares `OwnerRequiredSkillModifier` with
        //     skillTypeID = Drones (one of DDA's prerequisites). The
        //     bonus is +20.5% flat regardless of Drones level.
        //   - When skillTypeID is NOT in the source's required-skill set,
        //     the modifier IS scaled by that skill's level. Example: an
        //     Ishtar declares the same modifier with skillTypeID = Heavy
        //     Drone Operation, which Ishtar does NOT require. Bonus is
        //     `attribute × Heavy Drone Op level`.
        // Without this distinction, DDAs were giving "+20.5% × 5 = +102.5%"
        // each, which compounded to ~3.5× the in-game DPS.
        if (itemRequiresSkill(source, skillID)) {
            return { value: baseValue, scaled: false }
        }
        return { value: baseValue * level, scaled: true }
    }

    return { value: baseValue, scaled: false }
}

/** Ship hull "role bonus" attributes — Pyfa applies these as FLAT
 *  bonuses regardless of skill level, even when the carrying effect is
 *  declared as `LocationRequiredSkillModifier skillTypeID=X` (the skill
 *  is only used to filter which items receive the bonus, not to scale
 *  it). Naming convention: `shipBonusRole<N>` and a few one-off named
 *  variants with "RoleBonus" in them. */
const SHIP_ROLE_BONUS_ATTRS: ReadonlySet<number> = new Set([
    793,   // shipBonusRole7
    1688,  // shipBonusRole8
    1803,  // MWDSignatureRadiusBonus — Assault Frigate / Interceptor MWD sig role bonus (flat)
    2059,  // eliteBonusCommandDestroyer1 — Command Destroyer T2 specialisation (flat per-level applied via skill, but the SHIP-side reader is flat)
    2060,  // eliteBonusCommandDestroyer2
    2064,  // roleBonusCD — Command Destroyer command burst PG / activation cost reduction.
           //   Without this entry, effect 6214 (Draugur's `roleBonusCDLinksPGReduction`)
           //   double-applies the -95 % bonus at × Skirmish Command Burst V → -475 %
           //   PostPercent on Skirmish Command Burst II `power` (110) → -412.5 MW per
           //   burst → total ship power used reads −738 MW instead of +97 MW.
    2298,  // shipBonusRole1
    2299,  // shipBonusRole2
    2300,  // shipBonusRole3
    2301,  // shipBonusRole4
    2302,  // shipBonusRole5
    2303,  // shipBonusRole6
    5952,  // shipBonusGasCloudDurationRoleBonusOreMiningDestroyer
    // Rookie-ship (corvette) racial weapon DAMAGE bonuses. Effects 4991
    // (shipSETDmgBonusRookie), 5020 (shipSPTDmgBonusRookie), the hybrid and
    // missile equivalents apply these as a FLAT +10 % PostPercent on
    // damageMultiplier of modules requiring the racial small-weapon skill.
    // They're declared LocationRequiredSkillModifier with skillTypeID = that
    // weapon skill, but the skill only SELECTS the recipient modules — the
    // bonus is NOT per-level. Without these entries the ship-side reader
    // scaled +10 % × (Small Energy Turret V) → +50 %, inflating rookie-ship
    // turret DPS ~36 % (Impairor lasers, Reaper artillery, …).
    1823,  // rookieSETDamageBonus  (Small Energy Turret  — Amarr)
    1827,  // rookieMissileKinDamageBonus (missiles        — Caldari)
    1830,  // rookieSHTDamageBonus  (Small Hybrid Turret   — Gallente/Caldari)
    1836,  // rookieSPTDamageBonus  (Small Projectile Turret — Minmatar)
    1831,  // rookieDroneBonus — drone damageMultiplier (attr 64) + HP (attr 9)
           //   on drone-rookie hulls (Velator/Ibis/…). Effect
           //   shipBonusDroneDamageMultiplierRookie is OwnerRequiredSkillModifier
           //   gated on Drones (3436); the skill only selects the recipient
           //   drones, the +20 % is flat. Was scaling × Drones V → +100 %.
    // FLAT full-value role / special weapon+drone damage bonuses. Same shape as
    // the rookie bonuses: ORSM/LRSM whose skill is a recipient selector, value
    // is the FULL bonus (not per-level), so it must NOT be scaled by level.
    // (Per-level racial-hull bonuses use small values and fall through to the
    // generic scale-by-level path, which is correct at All-V.)
    1268,  // eliteBonusViolatorsLargeEnergyTurretDamageRole1 — Marauder
           //   (Paladin/Golem/Kronos/Vargur) +100 % weapon damage ROLE bonus.
           //   Was scaling × turret skill V → +500 % (Paladin weapon DPS ×3).
    1576,  // shipBonusSmallEnergyTurretDamageATF1 — AT frigate (Malice) +100 %.
    2580,  // industrialBonusDroneDamage — Orca +100 % drone damage (flat).
           //   (industrialCommandBonusDroneDamage attr 3203 is per-ICS-level
           //   scaled → it lives in SHIP_BONUS_SCALING_SKILL, not here.)
    3179,  // shipRoleBonusDroneDamage — mining barge (Procurer/…) +50 % role.
    5746,  // ATfrigDroneBonus — AT frigate (Sidewinder) +150 % drone damage.
    5748,  // AtcruiserDroneBonus — AT cruiser (Cobra) +150 % drone damage.
    1989,  // probeLauncherCPUPercentRoleBonusT3 value — effect 6009 on T3C hulls
           //   (Loki/Tengu/…): "-99 % CPU for Scan Probe Launchers". Declared as
           //   LocationRequiredSkillModifier gated on Astrometrics (3412), but
           //   the skill only SELECTS the recipient (probe launchers) — the bonus
           //   is FLAT. Without this entry the ship-domain reader scales it ×
           //   Astrometrics level → -99 % becomes -495 % PostPercent → a Loki
           //   Expanded Probe Launcher's 242 tf CPU flips to -955.9 tf and total
           //   CPU used reads -388 instead of +569.5.
])

/**
 * Decide the stacking penalty group for a given modifier. Returning null
 * means "no penalty" — the modifier multiplies at face value. Returning a
 * string means "this modifier shares a penalty stack with all other
 * modifiers using the same string key on the same attribute".
 */
function computeStackingGroup(
    source: ItemState,
    mi: SdeModifierInfo,
    dataset: FittingDataset,
    effect: SdeEffect,
): string | null {
    // 1. Source-kind exemptions: skills + ship + mode + subsystem + char never
    //    impose a stacking penalty (role/skill bonuses apply in full).
    if (NO_PENALTY_KINDS.has(source.kind)) return null

    // 2. Attribute schema exemption: attributes flagged `stackable=true` in
    //    the SDE bypass the penalty (e.g. raw HP additions).
    if (mi.modifiedAttributeID !== undefined) {
        const attr = dataset.attributes.get(mi.modifiedAttributeID)
        if (attr?.stackable) return null
    }

    // 3. Per-EFFECT penalty group (Pyfa-faithful, applied conservatively).
    //    Pyfa scopes the stacking penalty by a `penaltyGroup`: most module
    //    bonuses share the `default` group (penalised together per attribute —
    //    our long-standing behaviour), but a handful of effects use a CUSTOM
    //    group so they form their OWN independent chain. The canonical case is
    //    a cloak's scanResolution multiplier (`cloakingScanResolutionMultiplier`):
    //    it must NOT penalise against a Warp Core Stabilizer's scanResolution
    //    multiplier (default group), so the two apply in full (matching pyfa).
    //    We honour only the custom (non-`default`) groups here and leave every
    //    `default`/untable effect on the existing `attr:<id>` chain, so this
    //    can't regress the broad behaviour validated by the parity suite.
    const group = STACKING_PENALTY_GROUPS.get(effect.id)
    if (group !== undefined && group !== 'default' && CUSTOM_STACK_GROUPS_HONOURED.has(group)) {
        return `${group}:${mi.modifiedAttributeID}`
    }
    return `attr:${mi.modifiedAttributeID}`
}

/** Custom pyfa penaltyGroups we honour as INDEPENDENT chains. Kept to the set
 *  empirically verified not to regress the parity suite — the operation-named
 *  groups (postMul/postDiv/preMul/…) are NOT honoured because pyfa's real chain
 *  separation for those interacts with legacy-handled effects in ways our
 *  generic path doesn't reproduce 1:1. The cloak's scanResolution group is the
 *  clear, safe case: it must not penalise against a Warp Core Stabilizer. */
const CUSTOM_STACK_GROUPS_HONOURED: ReadonlySet<string> = new Set([
    'cloakingScanResolutionMultiplier',
])

function mapSourceKind(kind: ItemState['kind']): ModifierAffliction['sourceKind'] {
    // ItemKind has a few values that ModifierAffliction's sourceKind doesn't
    // distinguish (charge collapses into module for source attribution
    // purposes; the engine separately tracks charge effects). Keep the
    // public union narrow and map.
    switch (kind) {
        case 'ship':       return 'ship'
        case 'module':     return 'module'
        case 'charge':     return 'module'  // charge effects are attributed to its parent module
        case 'drone':      return 'drone'
        case 'fighter':    return 'drone'   // fighter ≈ drone for breakdown UI
        case 'implant':    return 'implant'
        case 'booster':    return 'booster'
        case 'subsystem':  return 'subsystem'
        case 'mode':       return 'mode'
        case 'character':  return 'skill'
    }
}

/**
 * Apply skill bonuses by walking the character's skill set and, for each
 * skill type, dispatching its passive effects through the modifier engine.
 *
 * EVE encodes "skill X gives bonus Y per level" as a passive effect on the
 * SKILL TYPE itself, with a LocationRequiredSkillModifier modifier whose
 * `skillTypeID` matches the skill in question. The character item carries a
 * synthetic effect set that delegates to the loaded skill types.
 *
 * This function does NOT mutate the character's effect list — it walks the
 * skill profile externally and applies skill effects directly on behalf of
 * the character source. Preserves correct attribution (sourceKind = 'skill').
 */
export function applySkills(
    ctx: FitContext,
    dataset: FittingDataset,
): void {
    const skills = dataset.typesByBucket.skills
    if (!skills) return  // skill bucket not loaded — caller's responsibility

    for (const [skillID, level] of ctx.skillLevels) {
        if (level <= 0) continue
        const skillType = skills.get(skillID)
        if (!skillType) continue
        // The skill's effects live on the skill TYPE. Walk them and apply
        // the same way as a regular item effect, but with `source` set to
        // the character (so domain resolution against `char` works) and
        // sourceKind override to 'skill'.
        for (const eRef of skillType.effects) {
            // Legacy "droneDmgBonus" effect (id 1730) and similar: empty
            // modifierInfo in modern SDE because their behaviour was
            // originally encoded as pre-expressions that Fenris Creations never ported
            // to the data-driven format. We re-implement them manually.
            // Without this, skills like Heavy Drone Operation, Light
            // Drone Operation, Medium Drone Operation, Sentry Drone
            // Interfacing and the racial Drone Specializations contribute
            // ZERO to drone damage even at level V.
            if (LEGACY_DRONE_DMG_EFFECT_IDS.has(eRef.id)) {
                applyLegacyDroneDmgBonus(skillType, skillID, level, ctx)
                continue
            }
            const missileChargeDmgAttr = LEGACY_MISSILE_CHARGE_DMG_EFFECTS.get(eRef.id)
            if (missileChargeDmgAttr !== undefined) {
                applyLegacyMissileChargeDmg(skillType, skillID, level, ctx, missileChargeDmgAttr)
                continue
            }
            if (eRef.id === 1851) {
                applyLegacyMissileSpecRof(skillType, skillID, level, ctx)
                continue
            }

            const effect = dataset.effects.get(eRef.id)
            if (!effect) continue
            for (const mi of effect.modifierInfo) {
                if (mi.func === 'EffectStopper') continue
                if (mi.modifiedAttributeID === undefined) continue
                if (mi.modifyingAttributeID === undefined) continue

                const op = mi.operation === undefined ? 'PostMul' : OPERATION_BY_SDE_CODE[mi.operation]
                if (!op) continue
                const isMul = op === 'PreMul' || op === 'PostMul'
                    || op === 'PreDiv' || op === 'PostDiv'

                // Standard skill-bonus pattern: per-level bonus value
                // lives on the skill type as an attribute, scale by
                // unit (PostPercent / percent unitID → divide by 100),
                // then multiply by level.
                const rawBase = skillType.attributes.find(a => a.id === mi.modifyingAttributeID)?.v
                if (rawBase === undefined) continue
                const sourceAttrMeta = dataset.attributes.get(mi.modifyingAttributeID)
                const baseVal = scaleForPipeline(rawBase, sourceAttrMeta?.unitID, op as ModifierOperation)

                // EVE's convention:
                //   - Multiplicative ops (PreMul/PostMul/PreDiv/PostDiv):
                //     baseVal is "+X% per level"; final multiplier is
                //     `1 + baseVal × level`. Without the offset, a
                //     5%-per-level skill at L5 would multiply the
                //     attribute by 0.25 (NUKE it down to a quarter).
                //   - PostPercent: pipeline already wraps as `1 + value`,
                //     so raw per-level × level is correct.
                //   - Additive (ModAdd/ModSub) and Assign: per-level
                //     × level applied directly.
                //
                // NOTE on `modifyingAttributeID === 280` (skillLevel) shape:
                // many racial ship skills carry effects shaped
                //   `dom=shipID|itemID target=<attr> source=280 op=PreMul`
                // — Pyfa interprets these as "ship.attr ×= skillLevel".
                // We DO NOT inject a level substitution here. The downstream
                // ship-side ItemModifier / LocationRequiredSkillModifier
                // that reads the target attr applies the `× level` itself
                // via `computeModifierValue` (either through the
                // SHIP_BONUS_SCALING_SKILL map for known scaled attrs, or
                // through the LRSM "skillTypeID is not source's required
                // skill" path). Substituting `value = level` HERE — and
                // letting the ship-side reader also scale — produces
                // catastrophic double-scaling (ship.attr ×= 5 then PostMul
                // -37.5 → -1.875 → ROF flips negative → DPS = 0 on Tempest;
                // resonance clamps to 100 % → infinite EHP on capitals).
                // See feedback_caldari_bs_skill_premul.md for the
                // experiment trail.
                const value = isMul ? (1 + baseVal * level) : (baseVal * level)
                const stackingGroup =
                    NO_PENALTY_KINDS.has('character') ? null : `attr:${mi.modifiedAttributeID}`

                const targets = resolveSkillTargets(mi, ctx)
                if (targets.length === 0) continue

                const affliction: ModifierAffliction = {
                    sourceKind: 'skill',
                    sourceID: `skill:${skillID}`,
                    operation: op as ModifierOperation,
                    value,
                    stackingGroup,
                }

                for (const t of targets) {
                    t.addAffliction(mi.modifiedAttributeID, affliction)
                }
            }
        }
    }
}

/** Effects whose behaviour is implemented as legacy pre-expressions in
 *  the SDE (modifierInfo is empty). We re-emulate them here. */
const LEGACY_DRONE_DMG_EFFECT_IDS: ReadonlySet<number> = new Set([
    1730,  // droneDmgBonus — Heavy/Light/Medium Drone Op, Drone Specs, Sentry Drone Interfacing
])

/** AB / MWD activation effect IDs (also legacy pre-expression). When the
 *  module is ACTIVE/OVERLOAD we apply the speed-and-mass formula manually.
 *  Verified against the SDE type list: every published MWD module carries
 *  effect 6730, every AB module carries 6731. (Effect 6732 lives on Armor
 *  Command Bursts, a different mechanic entirely — do not include.) */
const LEGACY_PROPMOD_EFFECT_IDS: ReadonlySet<number> = new Set([
    6730,  // moduleBonusMicrowarpdrive
    6731,  // moduleBonusAfterburner
])

const ATTR_DAMAGE_MULTIPLIER_BONUS = 292
const ATTR_DAMAGE_MULTIPLIER       = 64
const ATTR_MAX_VELOCITY            = 37
const ATTR_MASS                    = 4
const ATTR_SIGNATURE_RADIUS        = 552
const ATTR_SPEED_FACTOR            = 20    // module's "+X% velocity" factor
const ATTR_SPEED_BOOST_FACTOR      = 567   // module's thrust value
const ATTR_MASS_ADDITION           = 796   // mass added when active
const ATTR_SIGNATURE_RADIUS_BONUS  = 554   // MWD's sig-radius bloom % (signatureRadiusBonus)
// Hull resist resonances (smaller = more resist; PostMul to multiply by
// source resistance value).
const ATTR_HULL_EM_RES             = 113
const ATTR_HULL_THERM_RES          = 110
const ATTR_HULL_KIN_RES            = 109
const ATTR_HULL_EXP_RES            = 111
// Capital EHE source attrs (verified against SDE attr names):
const ATTR_HULL_EHE_EM_RES         = 974   // hullEmDamageResonance
const ATTR_HULL_EHE_THERM_RES      = 977   // hullThermalDamageResonance
const ATTR_HULL_EHE_KIN_RES        = 976   // hullKineticDamageResonance
const ATTR_HULL_EHE_EXP_RES        = 975   // hullExplosiveDamageResonance
// Armor resist resonances (RAH targets these on the SHIP).
const ATTR_ARMOR_EM_RES            = 267   // armorEmDamageResonance
const ATTR_ARMOR_EXP_RES           = 268   // armorExplosiveDamageResonance
const ATTR_ARMOR_KIN_RES           = 269   // armorKineticDamageResonance
const ATTR_ARMOR_THERM_RES         = 270   // armorThermalDamageResonance
const ATTR_RAH_RESISTANCE_SHIFT    = 1849  // resistanceShiftAmount
// Scan strengths.
const ATTR_SCAN_GRAVIMETRIC        = 208
const ATTR_SCAN_LADAR              = 209
const ATTR_SCAN_MAGNETOMETRIC      = 210
const ATTR_SCAN_RADAR              = 211
// HIC bubble + MJD bonus attrs.
const ATTR_MASS_BONUS_PERCENTAGE   = 1131  // massBonusPercentage
const ATTR_SIGNATURE_RADIUS_BONUS_LEGACY = 554   // signatureRadiusBonus (HIC bubble + target painter use this)
const ATTR_SIGNATURE_RADIUS_BONUS_PERCENT = 973  // signatureRadiusBonusPercent (MJD)
const ATTR_SPEED_FACTOR_BONUS      = 1164  // speedFactorBonus
const ATTR_SPEED_BOOST_FACTOR_BONUS = 1270 // speedBoostFactorBonus
const ATTR_DISALLOW_ASSISTANCE     = 854
// Projection range factor attrs.
const ATTR_RANGE_OPTIMAL           = 54    // maxRange
const ATTR_RANGE_FALLOFF           = 2044  // falloffEffectiveness
// EWAR projection target/source attrs.
const ATTR_MAX_TARGET_RANGE        = 76
const ATTR_MAX_TARGET_RANGE_BONUS  = 309
const ATTR_SCAN_RESOLUTION         = 564
const ATTR_SCAN_RESOLUTION_BONUS   = 566
const ATTR_TRACKING_SPEED          = 160
const ATTR_TRACKING_SPEED_BONUS    = 767
const ATTR_FALLOFF                 = 158
const ATTR_FALLOFF_BONUS           = 349
const ATTR_MAX_RANGE               = 54
const ATTR_MAX_RANGE_BONUS         = 351
const ATTR_AOE_CLOUD_SIZE          = 654
const ATTR_AOE_CLOUD_SIZE_BONUS    = 848
const ATTR_AOE_VELOCITY            = 653
const ATTR_AOE_VELOCITY_BONUS      = 847
const ATTR_EXPLOSION_DELAY         = 281
const ATTR_EXPLOSION_DELAY_BONUS   = 596
const ATTR_MISSILE_VELOCITY_BONUS  = 547
// Warfare buff attrs (command bursts).
const ATTR_WARFARE_BUFF_IDS: ReadonlyArray<readonly [number, number]> = [
    [2468, 2469], // warfareBuff1ID, warfareBuff1Value
    [2470, 2471], // warfareBuff2
    [2472, 2473], // warfareBuff3
    [2536, 2537], // warfareBuff4
]
const PROPULSION_MODULE_GROUP_ID   = 46  // dogma group "Propulsion Module"
const SKILL_GUNNERY                = 3300
const SKILL_MISSILE_LAUNCHER_OP    = 3319

/**
 * Re-implement the legacy drone-damage skill bonus.
 *
 *   bonus_pct = skillType.attr[292] × skillLevel
 *   target    = drones (or fighters) requiring `skillID`
 *   apply     = +bonus_pct%  (PostPercent on damageMultiplier)
 *   stacking  = bypassed (skill source)
 *
 * This pattern matches what Pyfa hardcodes for these skills. The skill's
 * attr 292 is in unit "Percentage" (105) so we /100 to get a fractional
 * multiplier. Multiplied by skillLevel gives the total bonus at that level.
 */
function applyLegacyDroneDmgBonus(
    skillType: { id: number; attributes: Array<{ id: number; v: number }> },
    skillID: number,
    level: number,
    ctx: FitContext,
): void {
    const bonusRaw = skillType.attributes.find(a => a.id === ATTR_DAMAGE_MULTIPLIER_BONUS)?.v
    if (bonusRaw === undefined || bonusRaw === 0) return
    const value = (bonusRaw / 100) * level  // PostPercent fraction
    const sourceID = `skill:${skillID}`

    const apply = (target: ItemState) => {
        target.addAffliction(ATTR_DAMAGE_MULTIPLIER, {
            sourceKind: 'skill',
            sourceID,
            operation: 'PostPercent',
            value,
            stackingGroup: null,  // skills bypass penalty
        })
    }

    for (const d of ctx.drones) {
        if (itemRequiresSkill(d, skillID)) apply(d)
    }
    for (const f of ctx.fighters) {
        if (itemRequiresSkill(f, skillID)) apply(f)
    }
}

/** Legacy missile-skill effect IDs. Each one targets a specific attribute
 *  on either the loaded charge (damage by type) or the launcher itself
 *  (rate of fire). The per-level magnitude is read from
 *  `damageMultiplierBonus` (attr 292) for the damage effects and from
 *  `rofBonus` (attr 293) for the ROF effect.
 *
 *  - 660 → emDamage on charges (filteredChargeBoost)
 *  - 661 → explosiveDamage on charges
 *  - 662 → thermalDamage on charges
 *  - 668 → kineticDamage on charges
 *  - 1851 → speed (ROF, attr 51) on launcher modules (filteredItemBoost)
 *
 *  Source attribute differs: damage effects read attr 292; ROF reads
 *  attr 293. Both are PostPercent and stack-free (skill source).
 */
const LEGACY_MISSILE_CHARGE_DMG_EFFECTS: ReadonlyMap<number, number> = new Map([
    [660, /* emDamage         */ 114],
    [661, /* explosiveDamage  */ 116],
    [668, /* kineticDamage    */ 117],
    [662, /* thermalDamage    */ 118],
])
const ATTR_ROF_BONUS = 293

function applyLegacyMissileChargeDmg(
    skillType: { id: number; attributes: Array<{ id: number; v: number }> },
    skillID: number,
    level: number,
    ctx: FitContext,
    targetAttr: number,
): void {
    const bonusRaw = skillType.attributes.find(a => a.id === ATTR_DAMAGE_MULTIPLIER_BONUS)?.v
    if (bonusRaw === undefined || bonusRaw === 0) return
    const value = (bonusRaw / 100) * level
    const sourceID = `skill:${skillID}`

    // DIRECT skill match (Pyfa-parity). The ammo's `requiredSkills`
    // attribute set is what Pyfa's `mod.charge.requiresSkill(skillName)`
    // checks — no transitive expansion through prerequisites. Mirroring
    // ensures we don't double-count missile damage bonuses through skill
    // prereq chains.
    for (const m of ctx.modules) {
        if (!m.charge) continue
        if (!itemRequiresSkill(m.charge, skillID)) continue
        m.charge.addAffliction(targetAttr, {
            sourceKind: 'skill',
            sourceID,
            operation: 'PostPercent',
            value,
            stackingGroup: null,
        })
    }
}

/** T2 missile Specialization ROF bonus (effect 1851). The skill carries
 *  `rofBonus` attr 293 (e.g. HAM Spec = -2) — multiplied by skill level
 *  and applied as PostPercent on the launcher module's `speed` (ATTR_SPEED
 *  = 51). Negative values speed up the launcher (-10% at V → × 0.9). */
function applyLegacyMissileSpecRof(
    skillType: { id: number; attributes: Array<{ id: number; v: number }> },
    skillID: number,
    level: number,
    ctx: FitContext,
): void {
    const bonusRaw = skillType.attributes.find(a => a.id === ATTR_ROF_BONUS)?.v
    if (bonusRaw === undefined || bonusRaw === 0) return
    const value = (bonusRaw / 100) * level
    const sourceID = `skill:${skillID}`

    // DIRECT skill match (Pyfa-parity). T2 launcher modules directly
    // require the corresponding Specialization skill (e.g. HAM Launcher II
    // requires HAM Specialization), so no transitive walk needed.
    for (const m of ctx.modules) {
        if (!itemRequiresSkill(m, skillID)) continue
        m.addAffliction(/* ATTR_SPEED */ 51, {
            sourceKind: 'skill',
            sourceID,
            operation: 'PostPercent',
            value,
            stackingGroup: null,
        })
    }
}

/**
 * Re-implement legacy AB / MWD activation (effects 6731 / 6732). Both
 * encode their bonus as pre-expressions so modifierInfo is empty in the
 * SDE; without manual handling the editor never reflects the speed
 * boost of an activated propulsion module.
 *
 * EVE's formula (verified against Pyfa + EVE wiki):
 *
 *   massEffective  = ship.mass + module.massAddition
 *   boost          = (speedFactor / 100) × thrust / massEffective
 *   newVelocity    = baseVelocity × (1 + boost)
 *
 * MWDs additionally bloom signature radius via `signatureRadiusBonus`.
 *
 * Pass-ordering note: this runs AFTER `applySourceItem` for every
 * module, so any speedFactor/thrust skill bonuses (Acceleration Control,
 * Navigation, etc.) are already baked into the module's `getFinal`
 * values when we read them.
 */
export function applyLegacyPropMods(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        // Only ACTIVE/OVERLOAD propulsion modules contribute.
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue

        // ItemState.effectIDs is a ReadonlySet<number>, not an array —
        // iterate the small constant set and probe with `.has()`.
        let isPropMod = false
        for (const eid of LEGACY_PROPMOD_EFFECT_IDS) {
            if (mod.effectIDs.has(eid)) { isPropMod = true; break }
        }
        if (!isPropMod) continue

        const speedFactor = mod.getFinal(ATTR_SPEED_FACTOR, 0)
        const thrust      = mod.getFinal(ATTR_SPEED_BOOST_FACTOR, 0)
        const massAdd     = mod.getFinal(ATTR_MASS_ADDITION, 0)
        if (speedFactor <= 0 || thrust <= 0) continue

        // 1) Add the module's mass to the ship. ModAdd, no stacking.
        ctx.ship.addAffliction(ATTR_MASS, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'ModAdd',
            value: massAdd,
            stackingGroup: null,
        })

        // 2) Compute boost using the post-mass-add effective ship mass.
        //    addAffliction invalidates the attribute cache, so getFinal
        //    re-runs the pipeline and includes the ModAdd we just made.
        const effectiveMass = ctx.ship.getFinal(ATTR_MASS, 1) || 1
        const boost = (speedFactor / 100) * thrust / effectiveMass

        ctx.ship.addAffliction(ATTR_MAX_VELOCITY, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'PostPercent',
            value: boost,
            stackingGroup: null,  // prop mods aren't stack-penalised in EVE
        })

        // 3) MWD-only: bloom the ship's signature radius. Pyfa-parity:
        //    the MWD bloom shares the `attr:552` stacking bucket with rig
        //    drawbacks (Core Defense Field Extender's signatureRadius
        //    PostPercent) — without this the rigs penalise among themselves
        //    only and the MWD slips in at full strength, over-blooming
        //    sig by a few percent on big fits with multiple sig rigs
        //    (Thunderchild + 3 CDFE was 3466 ours vs 3350 Pyfa). With the
        //    bucket shared, the MWD takes rank 0 (it's the largest bonus)
        //    and the rigs get bumped one slot down the penalty curve.
        const sigBonus = mod.getFinal(ATTR_SIGNATURE_RADIUS_BONUS, 0)
        if (sigBonus > 0) {
            ctx.ship.addAffliction(ATTR_SIGNATURE_RADIUS, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: sigBonus / 100,
                stackingGroup: `attr:${ATTR_SIGNATURE_RADIUS}`,
            })
        }
    }
}

// =============================================================================
// Additional legacy effect handlers — Pyfa-parity for empty-modifierInfo
// effects that the generic dispatcher silently drops.
// =============================================================================

/** Entosis Link (effect 6063). The Pyfa-equivalent handler boosts the
 *  ship's four scan strength attrs by the per-sensor bonus stored on the
 *  module (attrs 1027–1030). Doesn't disallow assistance — that flag lives
 *  on a different attribute that Entosis Link types don't carry; the
 *  in-game "no rep while entosis active" rule is enforced server-side and
 *  not via the dogma `disallowAssistance` attribute. */
const ENTOSIS_LINK_EFFECT_ID = 6063

export function applyLegacyEntosisLink(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state === 'OFFLINE') continue
        if (!mod.effectIDs.has(ENTOSIS_LINK_EFFECT_ID)) continue

        // Source attrs verified against Entosis Link I (typeID 34593):
        //   1027 → radar / 1028 → ladar / 1029 → magnetometric / 1030 → gravimetric
        // Stored as raw percent (100 = +100%).
        const sensorPairs: ReadonlyArray<readonly [number, number]> = [
            [1027, ATTR_SCAN_RADAR],
            [1028, ATTR_SCAN_LADAR],
            [1029, ATTR_SCAN_MAGNETOMETRIC],
            [1030, ATTR_SCAN_GRAVIMETRIC],
        ]
        for (const [srcAttr, tgtAttr] of sensorPairs) {
            const bonusPct = mod.getBase(srcAttr) ?? 0
            if (bonusPct === 0) continue
            ctx.ship.addAffliction(tgtAttr, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: bonusPct / 100,
                stackingGroup: null,
            })
        }
    }
}

/** Capital Emergency Hull Energizer (effect 6484). Active module that
 *  multiplies hull resonances by source resonance attrs (smaller = more
 *  resist). Stack-penalised. */
const CAPITAL_EHE_EFFECT_ID = 6484

export function applyLegacyCapitalEhe(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(CAPITAL_EHE_EFFECT_ID)) continue

        const pairs: ReadonlyArray<readonly [number, number]> = [
            [ATTR_HULL_EHE_EM_RES,    ATTR_HULL_EM_RES],
            [ATTR_HULL_EHE_THERM_RES, ATTR_HULL_THERM_RES],
            [ATTR_HULL_EHE_KIN_RES,   ATTR_HULL_KIN_RES],
            [ATTR_HULL_EHE_EXP_RES,   ATTR_HULL_EXP_RES],
        ]
        for (const [srcAttr, tgtAttr] of pairs) {
            const factor = mod.getBase(srcAttr) ?? 1
            if (factor === 1) continue
            ctx.ship.addAffliction(tgtAttr, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostMul',
                value: factor,
                stackingGroup: `attr:${tgtAttr}`,
            })
        }
    }
}

/** Heavy Interdiction Cruiser warp disruption sphere (effect 3380).
 *  When ACTIVE without a script: bloats ship mass + sig, applies the
 *  signed bonuses to fitted Propulsion Modules' speedFactor and
 *  speedBoostFactor (negative values cripple your own MWD), and forces
 *  `disallowAssistance = 1`. Source attrs verified against Pyfa
 *  Effect3380 + the SDE attribute name table. */
const HIC_BUBBLE_EFFECT_ID = 3380

export function applyLegacyHicBubble(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(HIC_BUBBLE_EFFECT_ID)) continue
        // Scripted HIC bubbles (loaded with focus point script) skip the
        // self-debuff entirely.
        if (mod.charge) continue

        // Force disallowAssistance flag.
        ctx.ship.addAffliction(ATTR_DISALLOW_ASSISTANCE, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'PostAssign',
            value: 1,
            stackingGroup: null,
        })

        const massBonus = mod.getBase(ATTR_MASS_BONUS_PERCENTAGE) ?? 0
        const sigBonus  = mod.getBase(ATTR_SIGNATURE_RADIUS_BONUS_LEGACY) ?? 0

        if (massBonus !== 0) {
            ctx.ship.addAffliction(ATTR_MASS, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: massBonus / 100,
                stackingGroup: null,
            })
        }
        if (sigBonus !== 0) {
            ctx.ship.addAffliction(ATTR_SIGNATURE_RADIUS, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: sigBonus / 100,
                stackingGroup: null,
            })
        }

        // Nerf own propulsion modules' speedFactor/thrust. Source attrs
        // 1164 (speedFactorBonus) + 1270 (speedBoostFactorBonus) — both
        // signed percent values; HIC stores them as negative on its
        // unscripted profile.
        const speedFactorNerf = mod.getBase(ATTR_SPEED_FACTOR_BONUS) ?? 0
        const thrustNerf      = mod.getBase(ATTR_SPEED_BOOST_FACTOR_BONUS) ?? 0
        if (speedFactorNerf === 0 && thrustNerf === 0) continue
        for (const target of ctx.modules) {
            if (target === mod) continue
            if (target.groupID !== PROPULSION_MODULE_GROUP_ID) continue
            if (speedFactorNerf !== 0) {
                target.addAffliction(ATTR_SPEED_FACTOR, {
                    sourceKind: 'module',
                    sourceID: mod.id,
                    operation: 'PostPercent',
                    value: speedFactorNerf / 100,
                    stackingGroup: null,
                })
            }
            if (thrustNerf !== 0) {
                target.addAffliction(ATTR_SPEED_BOOST_FACTOR, {
                    sourceKind: 'module',
                    sourceID: mod.id,
                    operation: 'PostPercent',
                    value: thrustNerf / 100,
                    stackingGroup: null,
                })
            }
        }
    }
}

/** Micro Jump Drive / Micro Jump Field Generator signature bloom — when
 *  active, the ship's signature radius is boosted by `signatureRadiusBonusPercent`.
 *  Pyfa effects 4921 / 6208 / 12126. The attr (973) is in unit 105 ("%")
 *  storing the raw percent number (e.g. 150 → +150%). */
const LEGACY_MJD_EFFECT_IDS: ReadonlySet<number> = new Set([4921, 6208, 12126])

export function applyLegacyMjdSigBloom(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        let isMjd = false
        for (const eid of LEGACY_MJD_EFFECT_IDS) {
            if (mod.effectIDs.has(eid)) { isMjd = true; break }
        }
        if (!isMjd) continue
        const bonusPct = mod.getFinal(ATTR_SIGNATURE_RADIUS_BONUS_PERCENT, 0)
        if (bonusPct === 0) continue
        ctx.ship.addAffliction(ATTR_SIGNATURE_RADIUS, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'PostPercent',
            value: bonusPct / 100,
            stackingGroup: `attr:${ATTR_SIGNATURE_RADIUS}`,  // stack-penalised with MWD bloom
        })
    }
}

/** Cap Booster handling (effect 48 `powerBooster`). Implementation lives
 *  in `derived/capacitor.ts::amortizedCapBoosterRate` because the
 *  injection rate must be amortised across the booster's reload window
 *  (typically 10 s) and that calculation can't be expressed as a simple
 *  affliction. The cap sim special-cases cap-booster modules at drain
 *  aggregation time. This function is therefore a no-op left in place
 *  for export-stability with prior callers. */
export function applyLegacyCapBoosterInjection(_ctx: FitContext): void {
    // intentionally empty — see derived/capacitor.ts
}

// =============================================================================
// Projection-falloff EWAR — generic helper + per-effect dispatch.
// =============================================================================

/**
 * Range factor for falloff-projected effects. Mirrors Pyfa's
 * `calculateRangeFactor` in `eos/calc.py`:
 *   - distance unset → 1.0 (full effect, in-optimal assumption)
 *   - both optimal and falloff are 0 (burst-style, e.g. AoE Doomsday
 *     burst projectors, ECM Burst Jammers) → 1.0 (caller has decided to
 *     project, target is in burst area)
 *   - falloff > 0:
 *       - distance > optimal + 3 × falloff → 0 (out of activation range)
 *       - else → 0.5 ** ((max(0, distance - optimal) / falloff) ** 2)
 *   - falloff <= 0:
 *       - distance <= optimal → 1, else 0 (hard cutoff)
 */
export function calculateProjectionRangeFactor(
    optimalRange: number,
    falloffRange: number,
    distance: number | undefined,
): number {
    if (distance === undefined) return 1
    if (optimalRange === 0 && falloffRange === 0) return 1
    if (falloffRange > 0) {
        if (distance > optimalRange + 3 * falloffRange) return 0
        const x = Math.max(0, distance - optimalRange) / falloffRange
        return Math.pow(0.5, x * x)
    }
    if (distance <= optimalRange) return 1
    return 0
}

interface ProjectionPair {
    /** Source attribute ID on the projected module (e.g. maxTargetRangeBonus). */
    srcAttr: number
    /** Target attribute ID on the receiver (e.g. maxTargetRange). */
    tgtAttr: number
}

interface ProjectionDef {
    effectID: number
    /** Where the modifications land. */
    target:
        | { kind: 'ship' }
        | { kind: 'modulesRequiringSkill'; skillID: number }
        | { kind: 'chargesRequiringSkill'; skillID: number }
    pairs: ReadonlyArray<ProjectionPair>
    /** True for friendly-buff projections (Remote Sensor Booster, Remote
     *  Tracking Computer). Default false (hostile EWAR). Gates on
     *  `disallowAssistance` instead of `disallowOffensiveModifiers`. */
    friendly?: boolean
}

/**
 * Effect-table for projection-falloff EWAR. Each entry maps an effect ID to
 * the source/target attribute pairs and the receiver location.
 *
 * Verified against Pyfa Effect6422/6423/6424/6425/6426 handler source.
 */
const PROJECTION_EWAR_DEFS: ReadonlyArray<ProjectionDef> = [
    // Sensor Damp (effect 6422) — reduces target's lock range and scan resolution.
    {
        effectID: 6422,
        target: { kind: 'ship' },
        pairs: [
            { srcAttr: ATTR_MAX_TARGET_RANGE_BONUS, tgtAttr: ATTR_MAX_TARGET_RANGE },
            { srcAttr: ATTR_SCAN_RESOLUTION_BONUS,  tgtAttr: ATTR_SCAN_RESOLUTION },
        ],
    },
    // Tracking Disruptor (effect 6424) — penalises target's gunnery modules.
    {
        effectID: 6424,
        target: { kind: 'modulesRequiringSkill', skillID: SKILL_GUNNERY },
        pairs: [
            { srcAttr: ATTR_TRACKING_SPEED_BONUS, tgtAttr: ATTR_TRACKING_SPEED },
            { srcAttr: ATTR_MAX_RANGE_BONUS,      tgtAttr: ATTR_MAX_RANGE },
            { srcAttr: ATTR_FALLOFF_BONUS,        tgtAttr: ATTR_FALLOFF },
        ],
    },
    // Guidance Disruptor (effect 6423) — penalises target's missile charges.
    {
        effectID: 6423,
        target: { kind: 'chargesRequiringSkill', skillID: SKILL_MISSILE_LAUNCHER_OP },
        pairs: [
            { srcAttr: ATTR_AOE_CLOUD_SIZE_BONUS,    tgtAttr: ATTR_AOE_CLOUD_SIZE },
            { srcAttr: ATTR_AOE_VELOCITY_BONUS,      tgtAttr: ATTR_AOE_VELOCITY },
            { srcAttr: ATTR_MISSILE_VELOCITY_BONUS,  tgtAttr: ATTR_MAX_VELOCITY },
            { srcAttr: ATTR_EXPLOSION_DELAY_BONUS,   tgtAttr: ATTR_EXPLOSION_DELAY },
        ],
    },
    // Target Painter (effect 6425) — boosts target ship's signature radius.
    {
        effectID: 6425,
        target: { kind: 'ship' },
        pairs: [
            { srcAttr: ATTR_SIGNATURE_RADIUS_BONUS_LEGACY, tgtAttr: ATTR_SIGNATURE_RADIUS },
        ],
    },
    // Stasis Web / Stasis Grappler (effect 6426) — slows target's max velocity.
    // Special-cased below since the source uses `speedFactor` (attr 20)
    // directly rather than a `*Bonus` attribute.
    {
        effectID: 6426,
        target: { kind: 'ship' },
        pairs: [
            { srcAttr: ATTR_SPEED_FACTOR, tgtAttr: ATTR_MAX_VELOCITY },
        ],
    },

    // -------- Burst Projector family (Marauder AoE bursts) --------
    // Same shape as the per-target equivalents but with no falloff —
    // `calculateProjectionRangeFactor` returns 1 when both optimal and
    // falloff are 0, so these naturally apply at full magnitude.
    { effectID: 6476, target: { kind: 'ship' }, pairs: [{ srcAttr: ATTR_SPEED_FACTOR, tgtAttr: ATTR_MAX_VELOCITY }] }, // AoE Web
    { effectID: 6478, target: { kind: 'ship' }, pairs: [{ srcAttr: ATTR_SIGNATURE_RADIUS_BONUS_LEGACY, tgtAttr: ATTR_SIGNATURE_RADIUS }] }, // AoE Paint
    { effectID: 6479,
      target: { kind: 'modulesRequiringSkill', skillID: SKILL_GUNNERY },
      pairs: [
          { srcAttr: ATTR_TRACKING_SPEED_BONUS, tgtAttr: ATTR_TRACKING_SPEED },
          { srcAttr: ATTR_MAX_RANGE_BONUS,      tgtAttr: ATTR_MAX_RANGE },
          { srcAttr: ATTR_FALLOFF_BONUS,        tgtAttr: ATTR_FALLOFF },
      ],
    }, // AoE Track
    { effectID: 6479, // AoE Track also affects missile charges per Pyfa Effect6479 (handled below)
      target: { kind: 'chargesRequiringSkill', skillID: SKILL_MISSILE_LAUNCHER_OP },
      pairs: [
          { srcAttr: ATTR_AOE_CLOUD_SIZE_BONUS,    tgtAttr: ATTR_AOE_CLOUD_SIZE },
          { srcAttr: ATTR_AOE_VELOCITY_BONUS,      tgtAttr: ATTR_AOE_VELOCITY },
          { srcAttr: ATTR_MISSILE_VELOCITY_BONUS,  tgtAttr: ATTR_MAX_VELOCITY },
          { srcAttr: ATTR_EXPLOSION_DELAY_BONUS,   tgtAttr: ATTR_EXPLOSION_DELAY },
      ],
    },
    { effectID: 6481, target: { kind: 'ship' }, pairs: [
        { srcAttr: ATTR_MAX_TARGET_RANGE_BONUS, tgtAttr: ATTR_MAX_TARGET_RANGE },
        { srcAttr: ATTR_SCAN_RESOLUTION_BONUS,  tgtAttr: ATTR_SCAN_RESOLUTION },
    ] }, // AoE Damp

    // -------- Standup structure variants (clones of player modules) --------
    { effectID: 6682, target: { kind: 'ship' }, pairs: [{ srcAttr: ATTR_SPEED_FACTOR, tgtAttr: ATTR_MAX_VELOCITY }] }, // Standup Web
    { effectID: 6683, target: { kind: 'ship' }, pairs: [{ srcAttr: ATTR_SIGNATURE_RADIUS_BONUS_LEGACY, tgtAttr: ATTR_SIGNATURE_RADIUS }] }, // Standup Paint
    { effectID: 6684, target: { kind: 'ship' }, pairs: [
        { srcAttr: ATTR_MAX_TARGET_RANGE_BONUS, tgtAttr: ATTR_MAX_TARGET_RANGE },
        { srcAttr: ATTR_SCAN_RESOLUTION_BONUS,  tgtAttr: ATTR_SCAN_RESOLUTION },
    ] }, // Standup Sensor Damp
    { effectID: 6686,
      target: { kind: 'modulesRequiringSkill', skillID: SKILL_GUNNERY },
      pairs: [
          { srcAttr: ATTR_TRACKING_SPEED_BONUS, tgtAttr: ATTR_TRACKING_SPEED },
          { srcAttr: ATTR_MAX_RANGE_BONUS,      tgtAttr: ATTR_MAX_RANGE },
          { srcAttr: ATTR_FALLOFF_BONUS,        tgtAttr: ATTR_FALLOFF },
      ],
    },
    { effectID: 6686,
      target: { kind: 'chargesRequiringSkill', skillID: SKILL_MISSILE_LAUNCHER_OP },
      pairs: [
          { srcAttr: ATTR_AOE_CLOUD_SIZE_BONUS,    tgtAttr: ATTR_AOE_CLOUD_SIZE },
          { srcAttr: ATTR_AOE_VELOCITY_BONUS,      tgtAttr: ATTR_AOE_VELOCITY },
          { srcAttr: ATTR_MISSILE_VELOCITY_BONUS,  tgtAttr: ATTR_MAX_VELOCITY },
          { srcAttr: ATTR_EXPLOSION_DELAY_BONUS,   tgtAttr: ATTR_EXPLOSION_DELAY },
      ],
    },

    // -------- Friendly buff projections --------
    // Remote Sensor Booster (effect 6427) — boosts target's lock range,
    // scan resolution, and all four sensor strengths.
    {
        effectID: 6427,
        target: { kind: 'ship' },
        friendly: true,
        pairs: [
            { srcAttr: ATTR_MAX_TARGET_RANGE_BONUS,  tgtAttr: ATTR_MAX_TARGET_RANGE },
            { srcAttr: ATTR_SCAN_RESOLUTION_BONUS,   tgtAttr: ATTR_SCAN_RESOLUTION },
            { srcAttr: 1027 /* scanGravimetricStrengthPercent */, tgtAttr: ATTR_SCAN_GRAVIMETRIC },
            { srcAttr: 1029 /* scanMagnetometricStrengthPercent */, tgtAttr: ATTR_SCAN_MAGNETOMETRIC },
            { srcAttr: 1030 /* scanRadarStrengthPercent */,        tgtAttr: ATTR_SCAN_RADAR },
            { srcAttr: 1028 /* scanLadarStrengthPercent */,        tgtAttr: ATTR_SCAN_LADAR },
        ],
    },
    // Remote Tracking Computer (effect 6428) — boosts target's gunnery
    // modules' tracking / range / falloff.
    {
        effectID: 6428,
        target: { kind: 'modulesRequiringSkill', skillID: SKILL_GUNNERY },
        friendly: true,
        pairs: [
            { srcAttr: ATTR_TRACKING_SPEED_BONUS, tgtAttr: ATTR_TRACKING_SPEED },
            { srcAttr: ATTR_MAX_RANGE_BONUS,      tgtAttr: ATTR_MAX_RANGE },
            { srcAttr: ATTR_FALLOFF_BONUS,        tgtAttr: ATTR_FALLOFF },
        ],
    },
]

/**
 * Apply a projection-falloff EWAR effect from `srcMod` to `target`. Reads
 * the module's optimal/falloff, multiplies each `srcAttr` by the range
 * factor, and pushes a stack-penalised PostPercent affliction on the
 * matching `tgtAttr` of every receiver.
 *
 * Receivers depend on the effect's `target` kind:
 *   - 'ship'                       → ctx.ship
 *   - 'modulesRequiringSkill'      → modules requiring the skill
 *   - 'chargesRequiringSkill'      → charges of modules requiring the skill
 */
function applyProjectionEwarEffect(
    srcMod: ItemState,
    def: ProjectionDef,
    distance: number | undefined,
    ctx: FitContext,
): void {
    const optimal = srcMod.getFinal(ATTR_RANGE_OPTIMAL, 0)
    const falloff = srcMod.getFinal(ATTR_RANGE_FALLOFF, 0)
    const factor = calculateProjectionRangeFactor(optimal, falloff, distance)
    if (factor === 0) return

    // Honour the appropriate gate flag on the target ship. Hostile EWAR
    // is gated by `disallowOffensiveModifiers` (872); friendly buffs
    // (RSB / RTC) are gated by `disallowAssistance` (854).
    const gateAttr = def.friendly === true ? ATTR_DISALLOW_ASSISTANCE : 872
    if (ctx.ship.getFinal(gateAttr, 0) > 0) return

    const pushAffliction = (target: ItemState, srcAttr: number, tgtAttr: number) => {
        const raw = srcMod.getFinal(srcAttr, 0)
        if (raw === 0) return
        target.addAffliction(tgtAttr, {
            sourceKind: 'module',  // projected hostile module
            sourceID: srcMod.id,
            operation: 'PostPercent',
            value: (raw / 100) * factor,
            stackingGroup: `proj:${def.effectID}:${tgtAttr}`,
        })
    }

    if (def.target.kind === 'ship') {
        for (const pair of def.pairs) pushAffliction(ctx.ship, pair.srcAttr, pair.tgtAttr)
        return
    }
    if (def.target.kind === 'modulesRequiringSkill') {
        const sid = def.target.skillID
        for (const m of ctx.modules) {
            if (!itemRequiresSkill(m, sid)) continue
            for (const pair of def.pairs) pushAffliction(m, pair.srcAttr, pair.tgtAttr)
        }
        return
    }
    // chargesRequiringSkill
    const sid = def.target.skillID
    for (const m of ctx.modules) {
        if (!m.charge) continue
        if (!itemRequiresSkill(m.charge, sid)) continue
        for (const pair of def.pairs) pushAffliction(m.charge, pair.srcAttr, pair.tgtAttr)
    }
}

/**
 * Run every projection-falloff EWAR handler against the projected source
 * list. Called from the engine's projection pass after the generic
 * `applySourceItem` dispatch (which won't have caught these because the
 * effects in question are pre-expressions in the SDE — empty modifierInfo).
 */
export function applyLegacyProjectionEwar(
    srcMod: ItemState,
    distance: number | undefined,
    ctx: FitContext,
): void {
    for (const def of PROJECTION_EWAR_DEFS) {
        if (!srcMod.effectIDs.has(def.effectID)) continue
        applyProjectionEwarEffect(srcMod, def, distance, ctx)
    }
}

// =============================================================================
// Projection-time helpers — remote rep, cap warfare, ECM, doomsday self-FX.
// These DON'T modify ship attributes via afflictions; instead they emit
// surface-level summary entries the engine returns through
// ProjectedEffectReport.
// =============================================================================

// Attribute IDs verified against the SDE attribute name table (2026-05-02).
const ATTR_DURATION_MS             = 73
const ATTR_SHIELD_REP_AMOUNT       = 68   // shieldBonus
const ATTR_ARMOR_REP_AMOUNT        = 84   // armorDamageAmount
const ATTR_HULL_REP_AMOUNT         = 83   // structureDamageAmount
const ATTR_POWER_TRANSFER_AMOUNT   = 90
const ATTR_NEUT_AMOUNT             = 97   // energyNeutralizerAmount
const ATTR_DISALLOW_OFFENSIVE      = 872  // disallowOffensiveModifiers
const ATTR_SCAN_RADAR_STR          = 208
const ATTR_SCAN_LADAR_STR          = 209
const ATTR_SCAN_MAGNETOMETRIC_STR  = 210
const ATTR_SCAN_GRAVIMETRIC_STR    = 211
const ATTR_SCAN_RADAR_BONUS        = 241  // scanRadarStrengthBonus
const ATTR_SCAN_LADAR_BONUS        = 239  // scanLadarStrengthBonus
const ATTR_SCAN_MAGNETOMETRIC_BONUS = 240 // scanMagnetometricStrengthBonus
const ATTR_SCAN_GRAVIMETRIC_BONUS  = 238  // scanGravimetricStrengthBonus
const ATTR_SIEGE_WARP_STATUS       = 852  // siegeModeWarpStatus
const ATTR_WARP_SCRAMBLE_STATUS    = 104  // warpScrambleStatus

/** Remote rep effect IDs → which layer they restore. Per-cycle amount is
 *  read from the indicated source attribute on the projecting module;
 *  the per-second value is `(amount × rangeFactor) / (duration / 1000)`. */
interface RemoteRepDef {
    effectID: number
    amountAttr: number
    layer: 'SHIELD' | 'ARMOR' | 'HULL'
}
const PROJECTION_REMOTE_REP_DEFS: ReadonlyArray<RemoteRepDef> = [
    { effectID: 6186, amountAttr: ATTR_SHIELD_REP_AMOUNT, layer: 'SHIELD' },
    { effectID: 6188, amountAttr: ATTR_ARMOR_REP_AMOUNT,  layer: 'ARMOR'  },
    { effectID: 6185, amountAttr: ATTR_HULL_REP_AMOUNT,   layer: 'HULL'   },
    // Ancillary remote reps: same shape — the +Nanite-paste boost on the
    // local AAR is gated by the SOURCE's loaded charge. We don't model
    // that on the projected side here (would need the projected source's
    // charge), so report the unfueled baseline. Fueled boost is Phase 5+.
    { effectID: 6651, amountAttr: ATTR_ARMOR_REP_AMOUNT,  layer: 'ARMOR'  },
    { effectID: 6652, amountAttr: ATTR_SHIELD_REP_AMOUNT, layer: 'SHIELD' },
]

/** Compute per-second received remote rep on the layer indicated by the
 *  effect, returning a ProjectedEffectReport-shaped row. Returns null if
 *  the source's `disallowAssistance` is set or the effect ID doesn't
 *  match. */
export function buildRemoteRepReport(
    srcMod: ItemState,
    distance: number | undefined,
    ctx: FitContext,
): { layer: 'SHIELD' | 'ARMOR' | 'HULL'; perSecond: number; effectID: number } | null {
    if (ctx.ship.getFinal(ATTR_DISALLOW_ASSISTANCE, 0) > 0) return null
    for (const def of PROJECTION_REMOTE_REP_DEFS) {
        if (!srcMod.effectIDs.has(def.effectID)) continue
        const optimal = srcMod.getFinal(ATTR_RANGE_OPTIMAL, 0)
        const falloff = srcMod.getFinal(ATTR_RANGE_FALLOFF, 0)
        const factor = calculateProjectionRangeFactor(optimal, falloff, distance)
        if (factor === 0) return null
        const amount = srcMod.getFinal(def.amountAttr, 0) * factor
        const cycleSec = srcMod.getFinal(ATTR_DURATION_MS, 0) / 1000
        if (cycleSec <= 0) return null
        return { layer: def.layer, perSecond: amount / cycleSec, effectID: def.effectID }
    }
    return null
}

/** Cap warfare effect IDs — neut (drain), nos (drain w/ refund), RCT
 *  (negative drain = injection). Per-second drain returned positive
 *  (target is being drained) for neut, NEGATIVE (target receives cap)
 *  for nos and RCT. Pyfa-parity with `addDrain`. */
interface CapWarfareDef {
    effectID: number
    amountAttr: number
    /** Sign of the per-second value as seen by the TARGET. */
    sign: 1 | -1
    /** Whether `disallowAssistance` (RCT-style buff) or `disallowOffensiveModifiers` (neut-style) gates the effect. */
    gateAttr: number
    kind: 'NEUT' | 'NOS' | 'REMOTE_CAP'
}
const PROJECTION_CAP_WARFARE_DEFS: ReadonlyArray<CapWarfareDef> = [
    { effectID: 6184, amountAttr: ATTR_POWER_TRANSFER_AMOUNT, sign: -1, gateAttr: ATTR_DISALLOW_ASSISTANCE, kind: 'REMOTE_CAP' },
    { effectID: 6187, amountAttr: ATTR_NEUT_AMOUNT,           sign:  1, gateAttr: ATTR_DISALLOW_OFFENSIVE, kind: 'NEUT' },
    { effectID: 6197, amountAttr: ATTR_POWER_TRANSFER_AMOUNT, sign:  1, gateAttr: ATTR_DISALLOW_OFFENSIVE, kind: 'NOS' },
    // Structure variants — same shape, different effect IDs.
    { effectID: 6216, amountAttr: ATTR_NEUT_AMOUNT,           sign:  1, gateAttr: ATTR_DISALLOW_OFFENSIVE, kind: 'NEUT' }, // Structure Energy Neutralizer
    // Marauder AoE Burst Projector — flat (no falloff), same neut shape.
    { effectID: 6477, amountAttr: ATTR_NEUT_AMOUNT,           sign:  1, gateAttr: ATTR_DISALLOW_OFFENSIVE, kind: 'NEUT' },
]

export function buildCapWarfareReport(
    srcMod: ItemState,
    distance: number | undefined,
    ctx: FitContext,
): { kind: CapWarfareDef['kind']; perSecond: number; effectID: number } | null {
    for (const def of PROJECTION_CAP_WARFARE_DEFS) {
        if (!srcMod.effectIDs.has(def.effectID)) continue
        if (ctx.ship.getFinal(def.gateAttr, 0) > 0) return null
        const optimal = srcMod.getFinal(ATTR_RANGE_OPTIMAL, 0)
        const falloff = srcMod.getFinal(ATTR_RANGE_FALLOFF, 0)
        const factor = calculateProjectionRangeFactor(optimal, falloff, distance)
        if (factor === 0) return null
        const amount = srcMod.getFinal(def.amountAttr, 0) * factor
        const cycleSec = srcMod.getFinal(ATTR_DURATION_MS, 0) / 1000
        if (cycleSec <= 0) return null
        return { kind: def.kind, perSecond: (def.sign * amount) / cycleSec, effectID: def.effectID }
    }
    return null
}

/** ECM projection (effects 6470, 6685, 6714). Reads the source's bonus
 *  matching the TARGET's primary scan flavour, applies range factor,
 *  computes per-cycle jam probability `sourceStrength / targetSensorStrength`. */
const PROJECTION_ECM_EFFECT_IDS: ReadonlySet<number> = new Set([6470, 6685, 6714])

/** Pick the target's primary sensor (the one with highest strength) and
 *  return its kind + value. */
function pickPrimarySensor(ship: ItemState): { kind: 'radar' | 'ladar' | 'magnetometric' | 'gravimetric'; strength: number; bonusAttr: number } {
    const candidates: Array<{ kind: 'radar' | 'ladar' | 'magnetometric' | 'gravimetric'; strength: number; bonusAttr: number }> = [
        { kind: 'radar',          strength: ship.getFinal(ATTR_SCAN_RADAR_STR,         0), bonusAttr: ATTR_SCAN_RADAR_BONUS },
        { kind: 'ladar',          strength: ship.getFinal(ATTR_SCAN_LADAR_STR,         0), bonusAttr: ATTR_SCAN_LADAR_BONUS },
        { kind: 'magnetometric',  strength: ship.getFinal(ATTR_SCAN_MAGNETOMETRIC_STR, 0), bonusAttr: ATTR_SCAN_MAGNETOMETRIC_BONUS },
        { kind: 'gravimetric',    strength: ship.getFinal(ATTR_SCAN_GRAVIMETRIC_STR,   0), bonusAttr: ATTR_SCAN_GRAVIMETRIC_BONUS },
    ]
    return candidates.reduce((best, c) => c.strength > best.strength ? c : best, candidates[0]!)
}

export function buildEcmProjectionReport(
    srcMod: ItemState,
    distance: number | undefined,
    ctx: FitContext,
): { jamChance: number } | null {
    let isEcm = false
    for (const eid of PROJECTION_ECM_EFFECT_IDS) {
        if (srcMod.effectIDs.has(eid)) { isEcm = true; break }
    }
    if (!isEcm) return null
    if (ctx.ship.getFinal(ATTR_DISALLOW_OFFENSIVE, 0) > 0) return null

    const primary = pickPrimarySensor(ctx.ship)
    if (primary.strength <= 0) return null

    // Read the source's per-flavour bonus matching the target's primary
    // sensor — Pyfa always pairs by target's strongest scan type.
    const sourceStrength = srcMod.getFinal(primary.bonusAttr, 0)
    if (sourceStrength <= 0) return null

    const optimal = srcMod.getFinal(ATTR_RANGE_OPTIMAL, 0)
    const falloff = srcMod.getFinal(ATTR_RANGE_FALLOFF, 0)
    const factor = calculateProjectionRangeFactor(optimal, falloff, distance)
    if (factor === 0) return null

    const effectiveStrength = sourceStrength * factor
    const jamChance = Math.max(0, Math.min(1, effectiveStrength / primary.strength))
    return { jamChance }
}

// =============================================================================
// Overheat / Overload bonuses. When a module is in state OVERLOAD, Pyfa
// applies a set of `overload*Bonus` attributes from the module to the
// corresponding base attributes via PostPercent. The handler runs after
// all other passes so the percent applies to the FULLY-MODIFIED base.
// Each pair below: (source attr on module, target attr on module).
// =============================================================================

const OVERHEAT_PAIRS: ReadonlyArray<readonly [number, number]> = [
    [1205, 51],   // overloadRofBonus → rate of fire (speed). Negative value = faster.
    [1210, 64],   // overloadDamageModifier → damageMultiplier. Positive = more damage.
    [1223, 20],   // overloadSpeedFactorBonus → speedFactor (prop mods). Positive = more boost.
    [1181, 73],   // overloadDurationBonus → duration (e.g. armor reps fast cycle). Negative = faster.
    [1230, 84],   // overloadArmorDamageAmount → armorDamageAmount (rep amount). Positive = more rep.
    [1153, 68],   // overloadShieldBonus → shieldBonus (shield boost amount). Positive = more boost.
]

export function applyLegacyOverload(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'OVERLOAD') continue
        for (const [srcAttr, tgtAttr] of OVERHEAT_PAIRS) {
            const bonus = mod.getBase(srcAttr) ?? 0
            if (bonus === 0) continue
            mod.addAffliction(tgtAttr, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: bonus / 100,
                stackingGroup: null,
            })
        }
    }
}

// =============================================================================
// Marauder Bastion Module (effect 6658). Active mode that simultaneously:
//  1. Multiplies all 12 ship resonances by source resonance attrs.
//  2. Boosts large-turret range/falloff/ROF.
//  3. Boosts missile range/explosion-velocity/ROF.
//  4. Boosts armor repper amount + shield booster amount (PostPercent).
//  5. Boosts repper duration AND capacitorNeed (PostPercent).
//  6. Stops the ship moving (negative speedFactor).
//  7. Boosts ship sensor strength.
//  8. Boosts EWAR resistances + remote-rep impedance.
//  9. Sets activationBlocked on MJD modules.
// 10. Increases warpScrambleStatus.
// =============================================================================

const BASTION_EFFECT_ID = 6658
const SKILL_LARGE_ENERGY_TURRET     = 3306
const SKILL_LARGE_HYBRID_TURRET     = 3308
const SKILL_LARGE_PROJECTILE_TURRET = 3304
const SKILL_LARGE_PRECURSOR_WEAPON  = 47872  // Large Precursor Weapon
const SKILL_TORPEDOES               = 3325
const SKILL_CRUISE_MISSILES         = 3326
const SKILL_HEAVY_MISSILES          = 3324
const SKILL_TORPEDO_SPEC            = 20213  // Torpedo Specialization
const SKILL_CRUISE_MISSILE_SPEC     = 20212  // Cruise Missile Specialization
const SKILL_REPAIR_SYSTEMS          = 3393
const SKILL_SHIELD_OPERATION        = 3416
const SKILL_MJD_OPERATION           = 4385   // Micro Jump Drive Operation

const ATTR_SHIELD_EM_RES            = 271
const ATTR_SHIELD_EXP_RES           = 272
const ATTR_SHIELD_KIN_RES           = 273
const ATTR_SHIELD_THERM_RES         = 274
const ATTR_SHIELD_BOOST_MULTIPLIER  = 548
const ATTR_SPEED                    = 51
const ATTR_CAPACITOR_NEED           = 6
const ATTR_ACTIVATION_BLOCKED       = 1349
const ATTR_ACTIVATION_BLOCKED_STR   = 1350
const ATTR_REMOTE_REPAIR_IMPEDANCE_BONUS = 2342
const ATTR_REMOTE_ASSIST_IMPEDANCE_BONUS = 2352
const ATTR_SENSOR_DAMP_RESIST_BONUS = 2351
const ATTR_WEAPON_DISRUPT_RESIST_BONUS = 2353
const ATTR_TARGET_PAINT_RESIST_BONUS = 2424
const ATTR_REMOTE_REPAIR_IMPEDANCE  = 2116
const ATTR_REMOTE_ASSIST_IMPEDANCE  = 2135
const ATTR_SENSOR_DAMP_RESIST       = 2112
const ATTR_WEAPON_DISRUPT_RESIST    = 2113
const ATTR_TARGET_PAINT_RESIST      = 2114
const ATTR_BASTION_REPAIR_DURATION_BONUS = 5964 // bastionModeArmorRepairAndShieldBoosterCapDurationBonus
const ATTR_ARMOR_DAMAGE_AMOUNT_BONUS = 895

export function applyLegacyBastion(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(BASTION_EFFECT_ID)) continue

        const ship = ctx.ship
        const sourceID = mod.id

        // 1. Resistances — shield/armor/hull resonances multiplied by Bastion's
        // resonance bonus attrs. Pyfa parity:
        //   - Operation: PreMul (op=0 in the SDE modifierInfo). Critical
        //     because DCU also applies as PreMul on the same resonance attrs;
        //     putting Bastion in PreMul shares the stacking pool so the
        //     stacking penalty composes the two bonuses correctly. If Bastion
        //     went into PostMul (separate pool), both bonuses applied at full
        //     strength → resists too high.
        //   - Source attrs for HULL are 974/977/976/975 (Bastion's
        //     `armorEm/Therm/Kin/ExpDamageResistanceBonus` family) NOT the
        //     ship's hull resonance ids 113/110/109/111. The Bastion module
        //     does not carry attrs 113/110/109/111, so reading those returns
        //     undefined and the hull bonus silently went missing.
        const resPairs: ReadonlyArray<readonly [number, number]> = [
            // [target_ship_attr, source_bastion_attr]
            [ATTR_SHIELD_EM_RES,    ATTR_SHIELD_EM_RES],
            [ATTR_SHIELD_THERM_RES, ATTR_SHIELD_THERM_RES],
            [ATTR_SHIELD_KIN_RES,   ATTR_SHIELD_KIN_RES],
            [ATTR_SHIELD_EXP_RES,   ATTR_SHIELD_EXP_RES],
            [ATTR_ARMOR_EM_RES,     ATTR_ARMOR_EM_RES],
            [ATTR_ARMOR_THERM_RES,  ATTR_ARMOR_THERM_RES],
            [ATTR_ARMOR_KIN_RES,    ATTR_ARMOR_KIN_RES],
            [ATTR_ARMOR_EXP_RES,    ATTR_ARMOR_EXP_RES],
            [ATTR_HULL_EM_RES,      974],   // bastion → hullEm via attr 974
            [ATTR_HULL_THERM_RES,   977],   // bastion → hullTherm via attr 977
            [ATTR_HULL_KIN_RES,     976],   // bastion → hullKin via attr 976
            [ATTR_HULL_EXP_RES,     975],   // bastion → hullExp via attr 975
        ]
        // Hull resonance attrs (109/110/111/113) are treated as a separate
        // stacking pool from DCU's matching modifiers — Pyfa parity, even
        // though both are PreMul in the SDE. Without this, DCU + Bastion on
        // hull stack-penalty together and hull EHP comes out ~5 % low
        // (Pyfa shows 73 % hull resist, stack-penalized would be ~72 %).
        // Shield / armor still penalize together because they have other
        // multi-source modifiers (membranes, hardeners, command bursts…)
        // that EVE *does* stack with DCU and Bastion in one pool.
        const HULL_RES_ATTRS = new Set<number>([
            ATTR_HULL_EM_RES, ATTR_HULL_THERM_RES, ATTR_HULL_KIN_RES, ATTR_HULL_EXP_RES,
        ])
        for (const [tgt, src] of resPairs) {
            const factor = mod.getBase(src) ?? 1
            if (factor === 1) continue
            ship.addAffliction(tgt, {
                sourceKind: 'module',
                sourceID,
                operation: 'PreMul',
                value: factor,
                stackingGroup: HULL_RES_ATTRS.has(tgt) ? null : `attr:${tgt}`,
            })
        }

        // 2. Turrets — Large Energy/Hybrid/Projectile + Large Precursor (range only)
        const maxRangeBonus = mod.getFinal(ATTR_MAX_RANGE_BONUS, 0)
        const falloffBonusV = mod.getFinal(ATTR_FALLOFF_BONUS, 0)
        const turretRofBonus = mod.getFinal(3109 /* bastionTurretROFBonus */, 0)
        const matchTurret = (m: ItemState) =>
            itemRequiresSkill(m, SKILL_LARGE_ENERGY_TURRET)
            || itemRequiresSkill(m, SKILL_LARGE_HYBRID_TURRET)
            || itemRequiresSkill(m, SKILL_LARGE_PROJECTILE_TURRET)
            || itemRequiresSkill(m, SKILL_LARGE_PRECURSOR_WEAPON)
        const matchTurretFalloff = (m: ItemState) =>
            itemRequiresSkill(m, SKILL_LARGE_ENERGY_TURRET)
            || itemRequiresSkill(m, SKILL_LARGE_HYBRID_TURRET)
            || itemRequiresSkill(m, SKILL_LARGE_PROJECTILE_TURRET)
        for (const target of ctx.modules) {
            if (matchTurret(target)) {
                if (maxRangeBonus !== 0) target.addAffliction(ATTR_MAX_RANGE, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: maxRangeBonus / 100, stackingGroup: `attr:${ATTR_MAX_RANGE}`,
                })
                if (turretRofBonus !== 0) target.addAffliction(ATTR_SPEED, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: turretRofBonus / 100, stackingGroup: `attr:${ATTR_SPEED}`,
                })
            }
            if (matchTurretFalloff(target) && falloffBonusV !== 0) {
                target.addAffliction(ATTR_FALLOFF, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: falloffBonusV / 100, stackingGroup: `attr:${ATTR_FALLOFF}`,
                })
            }
        }

        // 3. Missiles
        const missileVelocityBonus = mod.getFinal(ATTR_MISSILE_VELOCITY_BONUS, 0)
        const missileRofBonus = mod.getFinal(3108 /* bastionMissileROFBonus */, 0)
        const matchMissileCharge = (charge: ItemState) =>
            itemRequiresSkill(charge, SKILL_TORPEDOES)
            || itemRequiresSkill(charge, SKILL_CRUISE_MISSILES)
            || itemRequiresSkill(charge, SKILL_HEAVY_MISSILES)
        const matchMissileLauncherROF = (m: ItemState) =>
            itemRequiresSkill(m, SKILL_CRUISE_MISSILES)
            || itemRequiresSkill(m, SKILL_TORPEDOES)
            || itemRequiresSkill(m, SKILL_TORPEDO_SPEC)
            || itemRequiresSkill(m, SKILL_CRUISE_MISSILE_SPEC)
        for (const target of ctx.modules) {
            if (target.charge && matchMissileCharge(target.charge) && missileVelocityBonus !== 0) {
                target.charge.addAffliction(ATTR_MAX_VELOCITY, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: missileVelocityBonus / 100, stackingGroup: `attr:${ATTR_MAX_VELOCITY}`,
                })
            }
            if (matchMissileLauncherROF(target) && missileRofBonus !== 0) {
                target.addAffliction(ATTR_SPEED, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: missileRofBonus / 100, stackingGroup: `attr:${ATTR_SPEED}`,
                })
            }
        }

        // 4. Tanking — armor reps + shield boosters get amount + duration + cap bonus.
        // DIRECT skill match (Pyfa parity): only modules whose typeDogma
        // declares Repair Systems / Shield Operation as a DIRECT required
        // skill receive Bastion's tank bonuses. Remote-rep modules
        // (faction or T2 variants requiring `Remote Armor Repair Systems`
        // 16069) do NOT inherit the bonus via the prereq chain — Pyfa
        // shows their rep amount unchanged at base (228 HP / 5.4 s →
        // 42.2 HP/s on a 'Love' Medium Remote Armor Repairer). Note also
        // that Bastion's cap-need + cycle reductions both being -20 %
        // cancel out in per-second cap drain, so even when the bonuses
        // DO apply (self-reps), drain rate is unchanged from base.
        const armorRepBonus = mod.getFinal(ATTR_ARMOR_DAMAGE_AMOUNT_BONUS, 0)
        const shieldBoostBonus = mod.getFinal(ATTR_SHIELD_BOOST_MULTIPLIER, 0)
        const repairDurationBonus = mod.getFinal(ATTR_BASTION_REPAIR_DURATION_BONUS, 0)
        for (const target of ctx.modules) {
            const isArmor = itemRequiresSkill(target, SKILL_REPAIR_SYSTEMS)
            const isShield = itemRequiresSkill(target, SKILL_SHIELD_OPERATION)
            if (isArmor && armorRepBonus !== 0) {
                target.addAffliction(ATTR_ARMOR_REP_AMOUNT, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: armorRepBonus / 100, stackingGroup: `attr:${ATTR_ARMOR_REP_AMOUNT}`,
                })
            }
            if (isShield && shieldBoostBonus !== 0) {
                target.addAffliction(ATTR_SHIELD_REP_AMOUNT, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: shieldBoostBonus / 100, stackingGroup: `attr:${ATTR_SHIELD_REP_AMOUNT}`,
                })
            }
            if ((isArmor || isShield) && repairDurationBonus !== 0) {
                target.addAffliction(ATTR_DURATION_MS, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: repairDurationBonus / 100, stackingGroup: null,
                })
                target.addAffliction(ATTR_CAPACITOR_NEED, {
                    sourceKind: 'module', sourceID, operation: 'PostPercent',
                    value: repairDurationBonus / 100, stackingGroup: null,
                })
            }
        }

        // 5. Speed penalty (typically -100% so ship is immobile).
        const speedPenalty = mod.getFinal(ATTR_SPEED_FACTOR, 0)
        if (speedPenalty !== 0) {
            ship.addAffliction(ATTR_MAX_VELOCITY, {
                sourceKind: 'module', sourceID, operation: 'PostPercent',
                value: speedPenalty / 100, stackingGroup: null,
            })
        }

        // 6. Sensor strength (per-flavour).
        const sensorBonusPairs: ReadonlyArray<readonly [number, number]> = [
            [1027, ATTR_SCAN_GRAVIMETRIC],
            [1028, ATTR_SCAN_LADAR],
            [1029, ATTR_SCAN_MAGNETOMETRIC],
            [1030, ATTR_SCAN_RADAR],
        ]
        for (const [src, tgt] of sensorBonusPairs) {
            const v = mod.getFinal(src, 0)
            if (v === 0) continue
            ship.addAffliction(tgt, {
                sourceKind: 'module', sourceID, operation: 'PostPercent',
                value: v / 100, stackingGroup: `attr:${tgt}`,
            })
        }

        // 7. EWAR + remote-rep resistances.
        const resistPairs: ReadonlyArray<readonly [number, number]> = [
            [ATTR_REMOTE_REPAIR_IMPEDANCE_BONUS,  ATTR_REMOTE_REPAIR_IMPEDANCE],
            [ATTR_REMOTE_ASSIST_IMPEDANCE_BONUS,  ATTR_REMOTE_ASSIST_IMPEDANCE],
            [ATTR_SENSOR_DAMP_RESIST_BONUS,       ATTR_SENSOR_DAMP_RESIST],
            [ATTR_TARGET_PAINT_RESIST_BONUS,      ATTR_TARGET_PAINT_RESIST],
            [ATTR_WEAPON_DISRUPT_RESIST_BONUS,    ATTR_WEAPON_DISRUPT_RESIST],
        ]
        for (const [src, tgt] of resistPairs) {
            const v = mod.getFinal(src, 0)
            if (v === 0) continue
            ship.addAffliction(tgt, {
                sourceKind: 'module', sourceID, operation: 'PostPercent',
                value: v / 100, stackingGroup: null,
            })
        }

        // 8. Block MJD activation.
        const mjdBlock = mod.getFinal(ATTR_ACTIVATION_BLOCKED_STR, 0)
        if (mjdBlock !== 0) {
            for (const target of ctx.modules) {
                if (itemRequiresSkill(target, SKILL_MJD_OPERATION)) {
                    target.addAffliction(ATTR_ACTIVATION_BLOCKED, {
                        sourceKind: 'module', sourceID, operation: 'ModAdd',
                        value: mjdBlock, stackingGroup: null,
                    })
                }
            }
        }

        // 9. Increase warpScrambleStatus (uncloak/unwarp during bastion).
        const siegeStatus = mod.getFinal(ATTR_SIEGE_WARP_STATUS, 0)
        if (siegeStatus !== 0) {
            ship.addAffliction(ATTR_WARP_SCRAMBLE_STATUS, {
                sourceKind: 'module', sourceID, operation: 'ModAdd',
                value: siegeStatus, stackingGroup: null,
            })
        }
    }
}

// =============================================================================
// Mutadaptive Remote Armor Repairer (effect 7166).
// =============================================================================
//
// The mutadaptive RAR (Mutadaptive Remote Armor Repairer) ramps its rep
// amount per cycle as it stays active. After each cycle, the multiplier
// increases by `repairMultiplierBonusPerCycle` until it caps at
// `repairMultiplierBonusMax`. Pyfa exposes a per-fit "spool %" slider
// (0-100%) so the UI can show the rep amount at any spool point.
//
// Without a UI slider, we apply the FULL spool multiplier (100% spool)
// — a reasonable assumption for sustained engagement modelling. When the
// UI exposes a `spoolPercent` field on FitOptions / ProjectedSource, we
// can read it here and interpolate.

const MUTADAPTIVE_RAR_EFFECT_ID = 7166
const ATTR_MUTADAPTIVE_BONUS_MAX = 2767  // repairMultiplierBonusMax
const ATTR_MUTADAPTIVE_BONUS_PER_CYCLE = 2768  // repairMultiplierBonusPerCycle

export function applyLegacyMutadaptiveSpool(ctx: FitContext, spoolPercent: number): void {
    if (spoolPercent <= 0) return
    const clampedSpool = Math.max(0, Math.min(1, spoolPercent))
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(MUTADAPTIVE_RAR_EFFECT_ID)) continue

        const maxBonusPct = mod.getFinal(ATTR_MUTADAPTIVE_BONUS_MAX, 0)
        if (maxBonusPct <= 0) continue
        // PostPercent on the module's own armorDamageAmount so the
        // local-tank derive picks it up. spoolPercent linearly scales
        // the bonus (matches Pyfa's per-cycle ramp model: at 50% spool,
        // the rep amount is at 50% of the max bonus).
        mod.addAffliction(ATTR_ARMOR_REP_AMOUNT, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'PostPercent',
            value: (maxBonusPct / 100) * clampedSpool,
            stackingGroup: null,
        })
    }
}

// =============================================================================
// Doomsday self-effects (effects 6201/6472/6473/6474 + legacy 4489-4492).
// While active: speedFactor PostPercent on own maxVelocity (negative ==
// self-immobilise) + warpScrambleStatus increase (uncloakable/unwarpable
// while firing).
// =============================================================================

const LEGACY_DOOMSDAY_EFFECT_IDS: ReadonlySet<number> = new Set([
    6201, // doomsdaySlash (Reaper)
    6472, // doomsdayBeamDOT (Avatar/Erebus/Leviathan/Ragnarok lances)
    6473, // doomsdayConeDOT (Bosonic Field Generator)
    6474, // doomsdayHOG (Hyperion Gravity)
    4489, 4490, 4491, 4492, // legacy DD effects
])

export function applyLegacyDoomsdaySelfEffects(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        let isDD = false
        for (const eid of LEGACY_DOOMSDAY_EFFECT_IDS) {
            if (mod.effectIDs.has(eid)) { isDD = true; break }
        }
        if (!isDD) continue

        const speedFactor = mod.getFinal(ATTR_SPEED_FACTOR, 0)
        if (speedFactor !== 0) {
            ctx.ship.addAffliction(ATTR_MAX_VELOCITY, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PostPercent',
                value: speedFactor / 100,
                stackingGroup: `attr:${ATTR_MAX_VELOCITY}`,
            })
        }
        const siegeStatus = mod.getFinal(ATTR_SIEGE_WARP_STATUS, 0)
        if (siegeStatus !== 0) {
            ctx.ship.addAffliction(ATTR_WARP_SCRAMBLE_STATUS, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'ModAdd',
                value: siegeStatus,
                stackingGroup: null,
            })
        }
    }
}

// =============================================================================
// Command Bursts (warfare links) — effects 6732-6736 dispatch via
// `dbuffCollections`.
// =============================================================================

/** Effects on burst modules that publish warfare buffs. Each behaves the
 *  same way: read warfareBuff{N}ID from the charge, warfareBuff{N}Value
 *  from the module, dispatch via `dbuffCollections[id]`. */
const COMMAND_BURST_EFFECT_IDS: ReadonlySet<number> = new Set([
    6732, // moduleBonusWarfareLinkArmor
    6733, // moduleBonusWarfareLinkShield
    6734, // moduleBonusWarfareLinkSkirmish
    6735, // moduleBonusWarfareLinkInfo
    6736, // moduleBonusWarfareLinkMining
])

const OPERATION_BY_DBUFF_NAME: Record<string, ModifierOperation> = {
    PreAssignment: 'PreAssign',
    PreMul: 'PreMul',
    PreDiv: 'PreDiv',
    ModAdd: 'ModAdd',
    ModSub: 'ModSub',
    PostMul: 'PostMul',
    PostDiv: 'PostDiv',
    PostPercent: 'PostPercent',
    PostAssignment: 'PostAssign',
}

export function applyLegacyCommandBursts(ctx: FitContext): void {
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        let isBurst = false
        for (const eid of COMMAND_BURST_EFFECT_IDS) {
            if (mod.effectIDs.has(eid)) { isBurst = true; break }
        }
        if (!isBurst) continue
        // Burst modules need a loaded charge — the charge carries the
        // warfareBuff*ID attributes that pick which buffs to apply.
        const charge = mod.charge
        if (!charge) continue

        for (const [idAttr, valueAttr] of ATTR_WARFARE_BUFF_IDS) {
            const buffID = charge.getBase(idAttr) ?? 0
            if (buffID === 0) continue
            const value = mod.getFinal(valueAttr, 0)
            if (value === 0) continue
            applyCommandBuff(buffID, value, mod, ctx)
        }
    }
}

function applyCommandBuff(
    buffID: number,
    value: number,
    sourceMod: ItemState,
    ctx: FitContext,
): void {
    const dbuff = ctx.dataset.dbuffCollections.get(buffID)
    if (!dbuff) return
    const op = OPERATION_BY_DBUFF_NAME[dbuff.operationName]
    if (!op) return

    // PostPercent value-scaling (Pyfa-parity):
    //
    //   In Pyfa, every `addCommandBonus(buffID, value, ...)` call ends up
    //   calling `boostItemAttr(attr, value, stackingPenalties=True)`, which
    //   internally does `multiply(attr, 1 + value/100)` (see
    //   `eos/modifiedAttributeDict.py::boost`). i.e. Pyfa treats the buff
    //   value as a RAW PERCENT — `value=-10` means "× 0.9".
    //
    //   Our pipeline's PostPercent treats the affliction value as a
    //   FRACTION ALREADY — `value=0.05` means `× 1.05` (see
    //   `modifiedAttribute.ts::compile`, the `1 + a.value` line). So
    //   without scaling we'd compute `× (1 + -10) = × -9`, which (with
    //   stacking penalty across the four armor-resonance attrs) over-
    //   applies the dbuff catastrophically (Legion test fixture: armor
    //   resists jumped to 280-507 % with the bug).
    //
    //   Fix: divide by 100 for PostPercent (and only PostPercent — other
    //   ops use literal values: PostMul wants 0.5 → "× 0.5", ModAdd wants
    //   raw addition, etc).
    //
    //   ───────────────────────────────────────────────────────────────
    //   IMPORTANT: this conversion is paired with Effect 6737
    //   (`chargeBonusWarfareCharge`), which runs in the data-driven
    //   dispatcher and PostMul-multiplies the burst module's
    //   `warfareBuff{N}Value` by the charge's `warfareBuff{N}Multiplier`
    //   — that produces the final raw percent (`1.25 × -8 = -10` for
    //   Armor Energizing Charge in an Armor Command Burst II), which is
    //   what `value` here already is.
    //   ───────────────────────────────────────────────────────────────
    //
    //   Stacking group: dbuffs share a stack with anything modifying the
    //   same attribute via the same buff family — Pyfa scopes by
    //   "command burst", we scope by `buff:${buffID}` which is more
    //   precise.

    const scaledValue = op === 'PostPercent' ? value / 100 : value

    // Stacking group: Pyfa applies command-burst dbuffs via
    // `boostItemAttr(attr, value, stackingPenalties=True)`, which puts
    // them into the SAME generic per-attribute penalty pool as armor
    // hardeners / energized membranes / etc. We mirror that by using
    // the engine's default `attr:${id}` key — a buff-specific stacking
    // group ("buff:13") would erroneously apply the burst at FULL
    // strength even when the ship already has stacks of armor-resist
    // PostPercent modifiers, drastically over-tanking the resists
    // (Legion fixture: 2-3 pp overshoot per damage type).
    const affliction = (operation: ModifierOperation, attrID: number) => ({
        sourceKind: 'module' as const,
        sourceID: sourceMod.id,
        operation,
        value: scaledValue,
        stackingGroup: `attr:${attrID}`,
    })

    // Item modifiers — apply to the ship.
    for (const mi of dbuff.itemModifiers) {
        ctx.ship.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
    }
    // Location modifiers — apply to every item in the ship location.
    for (const mi of dbuff.locationModifiers) {
        ctx.ship.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
        for (const m of ctx.modules) m.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
        for (const d of ctx.drones) d.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
        for (const f of ctx.fighters) f.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
    }
    // LocationGroup modifiers — items in location with matching groupID.
    for (const mi of dbuff.locationGroupModifiers) {
        for (const m of ctx.modules) {
            if (m.groupID === mi.groupID) m.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
            if (m.charge && m.charge.groupID === mi.groupID) {
                m.charge.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
            }
        }
        for (const d of ctx.drones) {
            if (d.groupID === mi.groupID) d.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
        }
    }
    // LocationRequiredSkill modifiers — items requiring the skill (transitive).
    for (const mi of dbuff.locationRequiredSkillModifiers) {
        for (const m of ctx.modules) {
            if (itemRequiresSkill(m, mi.skillID)) {
                m.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
            }
            if (m.charge && itemRequiresSkill(m.charge, mi.skillID)) {
                m.charge.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
            }
        }
        for (const d of ctx.drones) {
            if (itemRequiresSkill(d, mi.skillID)) {
                d.addAffliction(mi.dogmaAttributeID, affliction(op, mi.dogmaAttributeID))
            }
        }
    }
}

// =============================================================================
// System Effects (Pyfa effect 4728 + the per-class wormhole effect
// handlers). Effect Beacons in group 920 — Incursion / Triglavian /
// Drifter / Wormhole class effects / Pochven Metaliminal storms /
// Drifter Incursion victories / system-wide warp speed bonus / etc. —
// are passive, system-wide modifiers that affect MANY stats besides
// resistances: signature radius, capacitor recharge, weapon damage,
// turret tracking, missile velocity & explosion radius, smartbomb
// damage & range, EWAR strength, drone speed & damage, shield
// capacity, armor HP, agility, warp speed, scan resolution, sensor
// strength, heat damage and overload bonuses.
//
// The user picks one beacon via the UI (the `systemEffectTypeID`
// option); the engine reads every dogma attribute on the beacon type
// and applies the corresponding affliction(s) per the spec table
// below. All system-effect afflictions bypass stacking penalty
// (`stackingGroup: null`) — Pyfa-parity, since they're system-wide
// passive auras and don't compete with module-stacked bonuses.
//
// Spec rows are derived from Pyfa source naming conventions:
//   - `*Multiplier` attrs store a literal multiplier (e.g. 1.3 → ×1.3)
//     applied as PostMul.
//   - `*Bonus` attrs store a percent (e.g. -15 → -15%), applied as
//     PostPercent with `value / 100` so `-15` becomes `× 0.85`.
//   - `*Add` attrs apply as ModAdd with the literal value.
// =============================================================================

const SMART_BOMB_GROUP_ID = 72

/** Frigate-class weapon skill IDs — used by the Wolf-Rayet small-
 *  weapon damage bonus (attr 1493) to filter modules whose primary
 *  requiredSkill matches a small-weapon class. */
const SMALL_TURRET_SKILL_IDS: ReadonlySet<number> = new Set([
    3300,  // Small Hybrid Turret
    3303,  // Small Energy Turret
    3315,  // Small Projectile Turret
])
const SMALL_MISSILE_SKILL_IDS: ReadonlySet<number> = new Set([
    3319,  // Missile Launcher Operation (rocket)
    3321,  // Light Missiles
])

function itemRequiresSkillOneOf(item: ItemState, skillIDs: ReadonlySet<number>): boolean {
    for (const req of item.requiredSkills()) {
        if (skillIDs.has(req.skillID)) return true
    }
    return false
}

const SHIELD_BOOSTER_EFFECT_IDS = new Set<number>([4, 4936])
const ARMOR_REPAIRER_EFFECT_IDS = new Set<number>([27, 5275])
const REMOTE_SHIELD_XFER_EFFECT_IDS = new Set<number>([18, 6186, 6652])
const REMOTE_ARMOR_REP_EFFECT_IDS = new Set<number>([592, 6188, 6651])
const ENERGY_NEUTRALIZER_EFFECT_IDS = new Set<number>([28, 6187, 6477, 6691])
const ENERGY_NOSFERATU_EFFECT_IDS = new Set<number>([1, 6197])
const STASIS_WEB_EFFECT_IDS = new Set<number>([14, 6426, 6476, 6682])
const TARGET_PAINTER_EFFECT_IDS = new Set<number>([1019, 6425, 6478, 6683])

type Receiver =
    | 'ship'
    | 'turrets'
    | 'missiles'           // missile launchers themselves
    | 'missileCharges'     // missile charges loaded in launchers
    | 'smartbombs'
    | 'shieldBoosters'     // local shield boosters
    | 'armorRepairers'     // local armor reps
    | 'remoteShieldTransfer'
    | 'remoteArmorRep'
    | 'energyNeut'
    | 'energyNos'
    | 'webifiers'
    | 'targetPainters'
    | 'drones'

interface SystemEffectSpec {
    /** Attribute ID on the Effect Beacon type. */
    beaconAttr: number
    /** Item population to apply the affliction to. */
    receiver: Receiver
    /** Attribute ID on the receiving item to modify. */
    targetAttr: number
    /** PostMul (literal multiplier), PostPercent (percent / 100),
     *  ModAdd (literal additive). */
    operation: 'PostMul' | 'PostPercent' | 'ModAdd'
}

/**
 * SDE attribute → engine action map for system-effect beacons. Each row
 * is a hand-curated translation from Pyfa's per-effect Python class to
 * a data-driven affliction. Sourced from beacon dogma attribute names +
 * cross-referenced to wormhole class effect documentation.
 *
 * When Fenris Creations introduces a new beacon attribute, add a row here AFTER
 * verifying the math against Pyfa or in-game stats. Unmapped beacon
 * attrs are silently ignored — surface them via the audit script if
 * they start carrying values that should affect the panel.
 */
const SYSTEM_EFFECT_SPECS: ReadonlyArray<SystemEffectSpec> = [
    // ---- Resistances (PostPercent on resonance, /100). Negative =
    //      better resist (resonance ↓), positive = worse (resonance ↑). ----
    { beaconAttr: 1465, receiver: 'ship', targetAttr: 267, operation: 'PostPercent' }, // armorEmRes
    { beaconAttr: 1466, receiver: 'ship', targetAttr: 269, operation: 'PostPercent' }, // armorKinRes
    { beaconAttr: 1467, receiver: 'ship', targetAttr: 270, operation: 'PostPercent' }, // armorThermRes
    { beaconAttr: 1468, receiver: 'ship', targetAttr: 268, operation: 'PostPercent' }, // armorExpRes
    { beaconAttr: 1489, receiver: 'ship', targetAttr: 271, operation: 'PostPercent' }, // shieldEmRes
    { beaconAttr: 1490, receiver: 'ship', targetAttr: 272, operation: 'PostPercent' }, // shieldExpRes
    { beaconAttr: 1491, receiver: 'ship', targetAttr: 273, operation: 'PostPercent' }, // shieldKinRes
    { beaconAttr: 1492, receiver: 'ship', targetAttr: 274, operation: 'PostPercent' }, // shieldThermRes
    // Hull resists (Drifter Incursion victories carry these).
    { beaconAttr: 984,  receiver: 'ship', targetAttr: 113, operation: 'PostPercent' }, // hullEmRes (113)
    { beaconAttr: 985,  receiver: 'ship', targetAttr: 111, operation: 'PostPercent' }, // hullExpRes
    { beaconAttr: 986,  receiver: 'ship', targetAttr: 109, operation: 'PostPercent' }, // hullKinRes
    { beaconAttr: 987,  receiver: 'ship', targetAttr: 110, operation: 'PostPercent' }, // hullThermRes

    // ---- Ship hull / cap / sig (PostMul, literal value) ----
    { beaconAttr: 146,  receiver: 'ship', targetAttr: 263, operation: 'PostMul' },   // shieldCapacityMultiplier → shieldCapacity
    { beaconAttr: 148,  receiver: 'ship', targetAttr: 265, operation: 'PostMul' },   // armorHPMultiplier → armorHP
    { beaconAttr: 169,  receiver: 'ship', targetAttr: 70,  operation: 'PostMul' },   // agilityMultiplier → agility
    { beaconAttr: 237,  receiver: 'ship', targetAttr: 76,  operation: 'PostMul' },   // maxTargetRangeMultiplier
    { beaconAttr: 652,  receiver: 'ship', targetAttr: 552, operation: 'PostMul' },   // signatureRadiusMultiplier
    { beaconAttr: 1499, receiver: 'ship', targetAttr: 482, operation: 'PostMul' },   // capacitorCapacityMultiplierSystem
    { beaconAttr: 1500, receiver: 'ship', targetAttr: 55,  operation: 'PostMul' },   // rechargeRateMultiplier (cap recharge time)
    { beaconAttr: 1840, receiver: 'ship', targetAttr: 479, operation: 'PostMul' },   // shieldRechargeRateMultiplier (Cataclysmic)

    // ---- Ship hull (PostPercent / ModAdd bonuses) ----
    { beaconAttr: 327,  receiver: 'ship', targetAttr: 9,   operation: 'PostPercent' }, // hullHpBonus
    { beaconAttr: 151,  receiver: 'ship', targetAttr: 70,  operation: 'PostPercent' }, // agilityBonus (additive percent)
    { beaconAttr: 309,  receiver: 'ship', targetAttr: 76,  operation: 'PostPercent' }, // maxTargetRangeBonus
    { beaconAttr: 566,  receiver: 'ship', targetAttr: 564, operation: 'PostPercent' }, // scanResolutionBonus
    { beaconAttr: 601,  receiver: 'ship', targetAttr: 600, operation: 'PostPercent' }, // warpSpeedBonus → warpSpeedMultiplier
    { beaconAttr: 1950, receiver: 'ship', targetAttr: 600, operation: 'ModAdd' },      // warpSpeedAdd (System-Wide Warp Speed Bonus)
    { beaconAttr: 1851, receiver: 'ship', targetAttr: 208, operation: 'PostPercent' }, // sensorStrengthBonus → scanRadarStrength (sample; LADAR/MAG/GRAV
                                                                                       //   covered by parallel attrs if SDE adds them — currently only
                                                                                       //   `sensorStrengthBonus` exists on the beacon, applied to the
                                                                                       //   primary sensor type slot. Refine if a fixture surfaces drift.)

    // ---- Velocity / propulsion ----
    { beaconAttr: 20,   receiver: 'ship', targetAttr: 37,  operation: 'PostPercent' }, // speedFactor (Drifter Incursion victory) → maxVelocity
    { beaconAttr: 306,  receiver: 'ship', targetAttr: 37,  operation: 'PostPercent' }, // maxVelocityModifier (Omni Effect Beacon)

    // ---- Turret weapons (Magnetar damage + tracking debuff) ----
    { beaconAttr: 1482, receiver: 'turrets', targetAttr: 64,  operation: 'PostMul' }, // damageMultiplierMultiplier → turret damageMultiplier
    { beaconAttr: 244,  receiver: 'turrets', targetAttr: 160, operation: 'PostMul' }, // trackingSpeedMultiplier
    { beaconAttr: 767,  receiver: 'turrets', targetAttr: 160, operation: 'PostPercent' }, // trackingSpeedBonus

    // ---- Missiles (Black Hole velocity + flight time, Magnetar AoE) ----
    { beaconAttr: 1469, receiver: 'missileCharges', targetAttr: 37,  operation: 'PostMul' },  // missileVelocityMultiplier → maxVelocity (charge)
    { beaconAttr: 1470, receiver: 'missileCharges', targetAttr: 281, operation: 'PostMul' },  // (paired w/ 1469) explosionDelay multiplier → flight time / range
    { beaconAttr: 1483, receiver: 'missileCharges', targetAttr: 653, operation: 'PostMul' },  // aoeVelocityMultiplier → explosionVelocity
    { beaconAttr: 1967, receiver: 'missileCharges', targetAttr: 654, operation: 'PostMul' },  // aoeCloudSizeMultiplier → aoeCloudSize / explosionRadius

    // ---- Smartbombs (Red Giant) ----
    { beaconAttr: 1487, receiver: 'smartbombs', targetAttr: 97, operation: 'PostMul' }, // empFieldRangeMultiplier → smartbomb radius
    { beaconAttr: 1488, receiver: 'smartbombs', targetAttr: 114, operation: 'PostMul' }, // smartbombDamageMultiplier (em)
    { beaconAttr: 1488, receiver: 'smartbombs', targetAttr: 116, operation: 'PostMul' }, // (exp)
    { beaconAttr: 1488, receiver: 'smartbombs', targetAttr: 117, operation: 'PostMul' }, // (kin)
    { beaconAttr: 1488, receiver: 'smartbombs', targetAttr: 118, operation: 'PostMul' }, // (therm)

    // ---- Local reps (Cataclysmic local rep penalty) ----
    { beaconAttr: 1495, receiver: 'armorRepairers', targetAttr: 84, operation: 'PostMul' }, // armorDamageAmountMultiplier
    { beaconAttr: 1496, receiver: 'shieldBoosters', targetAttr: 68, operation: 'PostMul' }, // shieldBonusMultiplier (local SB amount)

    // ---- Remote reps (Cataclysmic remote rep buff) ----
    { beaconAttr: 1497, receiver: 'remoteShieldTransfer', targetAttr: 68, operation: 'PostMul' }, // shieldBonusMultiplierRemote
    { beaconAttr: 1498, receiver: 'remoteArmorRep',       targetAttr: 84, operation: 'PostMul' }, // armorDamageAmountMultiplierRemote

    // ---- Energy warfare (Pulsar buff) ----
    { beaconAttr: 1966, receiver: 'energyNeut', targetAttr: 97, operation: 'PostMul' }, // energyWarfareStrengthMultiplier → neut amount
    { beaconAttr: 1966, receiver: 'energyNos',  targetAttr: 97, operation: 'PostMul' }, // ditto for NOS

    // ---- EWAR (Magnetar painter penalty, Black Hole web penalty) ----
    { beaconAttr: 1968, receiver: 'targetPainters', targetAttr: 554, operation: 'PostMul' }, // targetPainterStrengthMultiplier → signatureRadiusBonus
    { beaconAttr: 1969, receiver: 'webifiers',      targetAttr: 20,  operation: 'PostMul' }, // stasisWebStrengthMultiplier → speedFactor

    // ---- Drones ----
    { beaconAttr: 591,  receiver: 'drones', targetAttr: 37, operation: 'PostPercent' }, // droneMaxVelocityBonus
    { beaconAttr: 1255, receiver: 'drones', targetAttr: 64, operation: 'PostPercent' }, // droneDamageBonus → damageMultiplier

    // ---- Overload / heat (Red Giant overload boost + heat penalty) ----
    { beaconAttr: 1485, receiver: 'ship', targetAttr: 1211, operation: 'PostMul' },     // heatDamageMultiplier
    { beaconAttr: 1229, receiver: 'ship', targetAttr: 1211, operation: 'PostPercent' }, // thermodynamicsHeatDamage (Volatile Ice Storm)
    // overloadBonusMultiplier (1486) — applies to module overload bonus
    // attrs (e.g. overloadSpeedFactorBonus, overloadRofBonus). Pyfa walks
    // every overload-* attr family and PostMuls them; we deliberately
    // skip until a fixture exercises an overloaded module under Red Giant
    // — overload math itself is currently approximate (see CLAUDE.md
    // "Fitting Tool" trap log).
]

const RECEIVER_PREDICATES: Record<Receiver, (m: ItemState) => boolean> = {
    ship:                  () => false,  // ship is handled separately
    turrets:               (m) => {
        for (const eid of m.effectIDs) if (eid === 10 || eid === 34 || eid === 6995 || eid === 8037) return true
        return false
    },
    missiles:              (m) => m.effectIDs.has(9) || m.effectIDs.has(101),
    missileCharges:        () => false,  // applied via parent module's loaded charge
    smartbombs:            (m) => m.groupID === SMART_BOMB_GROUP_ID,
    shieldBoosters:        (m) => intersects(m.effectIDs, SHIELD_BOOSTER_EFFECT_IDS),
    armorRepairers:        (m) => intersects(m.effectIDs, ARMOR_REPAIRER_EFFECT_IDS),
    remoteShieldTransfer:  (m) => intersects(m.effectIDs, REMOTE_SHIELD_XFER_EFFECT_IDS),
    remoteArmorRep:        (m) => intersects(m.effectIDs, REMOTE_ARMOR_REP_EFFECT_IDS),
    energyNeut:            (m) => intersects(m.effectIDs, ENERGY_NEUTRALIZER_EFFECT_IDS),
    energyNos:             (m) => intersects(m.effectIDs, ENERGY_NOSFERATU_EFFECT_IDS),
    webifiers:             (m) => intersects(m.effectIDs, STASIS_WEB_EFFECT_IDS),
    targetPainters:        (m) => intersects(m.effectIDs, TARGET_PAINTER_EFFECT_IDS),
    drones:                () => false,  // drones handled separately
}

function intersects(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    for (const x of a) if (b.has(x)) return true
    return false
}

/** Apply an Effect Beacon (system effect) by reading its dogma attributes
 *  from the dataset and pushing the corresponding afflictions onto the
 *  fit's ship + modules + charges + drones per SYSTEM_EFFECT_SPECS. */
export function applyLegacySystemEffect(
    ctx: FitContext,
    beaconTypeID: number | null | undefined,
): void {
    if (!beaconTypeID) return
    const beacon = ctx.dataset.getType(beaconTypeID)
    if (!beacon) return
    const beaconAttrs = new Map(beacon.attributes.map(a => [a.id, a.v]))

    const ship = ctx.ship
    const sourceID = `beacon:${beaconTypeID}`

    for (const spec of SYSTEM_EFFECT_SPECS) {
        const raw = beaconAttrs.get(spec.beaconAttr)
        if (raw === undefined || raw === 0) continue
        const value = spec.operation === 'PostPercent' ? raw / 100 : raw
        const aff = {
            sourceKind: 'module' as const,
            sourceID,
            operation: spec.operation,
            value,
            stackingGroup: null,
        }

        if (spec.receiver === 'ship') {
            ship.addAffliction(spec.targetAttr, aff)
            continue
        }
        if (spec.receiver === 'drones') {
            for (const d of ctx.drones) d.addAffliction(spec.targetAttr, aff)
            continue
        }
        if (spec.receiver === 'missileCharges') {
            for (const m of ctx.modules) {
                if (!m.charge) continue
                if (!m.effectIDs.has(9) && !m.effectIDs.has(101)) continue
                m.charge.addAffliction(spec.targetAttr, aff)
            }
            continue
        }
        const predicate = RECEIVER_PREDICATES[spec.receiver]
        for (const m of ctx.modules) {
            if (!predicate(m)) continue
            m.addAffliction(spec.targetAttr, aff)
        }
    }

    // Legacy: missile-launcher charges (effects 9/101) get the same
    // per-damage-type reduction as smartbombs via the
    // `systemEffectDamageReduction` attribute (1686 — Triglavian Invasion)
    // and `systemEffectDamageReduction2` (203 — Pochven storms). 1:N
    // fan-out (one beacon attr → 4 damage attrs × 2 receiver
    // populations) so kept inline rather than expressed in
    // SYSTEM_EFFECT_SPECS.
    const damageAttrs = [114, 116, 117, 118]
    for (const beaconAttrID of [1686, 203]) {
        const reduction = beaconAttrs.get(beaconAttrID) ?? 0
        if (reduction === 0) continue
        const aff = {
            sourceKind: 'module' as const,
            sourceID,
            operation: 'PostPercent' as const,
            value: reduction / 100,
            stackingGroup: null,
        }
        for (const m of ctx.modules) {
            if (m.groupID === SMART_BOMB_GROUP_ID) {
                for (const attr of damageAttrs) m.addAffliction(attr, aff)
                continue
            }
            if (m.charge && itemRequiresSkill(m.charge, SKILL_MISSILE_LAUNCHER_OP)) {
                for (const attr of damageAttrs) m.charge.addAffliction(attr, aff)
            }
        }
    }

    // Wolf-Rayet small-weapon damage bonus (attr 1493). Same fan-out
    // problem as 1686 — one beacon attr drives a damage scale on
    // small turret modules (PostMul on damageMultiplier 64) AND on
    // small missile launcher charges (PostMul on damage attrs 114-118).
    // "Small" = the module's primary required skill is one of the
    // frigate-class weapon skills.
    const smallWeaponMul = beaconAttrs.get(1493) ?? 0
    if (smallWeaponMul !== 0 && smallWeaponMul !== 1) {
        const aff = {
            sourceKind: 'module' as const,
            sourceID,
            operation: 'PostMul' as const,
            value: smallWeaponMul,
            stackingGroup: null,
        }
        for (const m of ctx.modules) {
            const isSmallTurret = (m.effectIDs.has(10) || m.effectIDs.has(34) || m.effectIDs.has(6995))
                && itemRequiresSkillOneOf(m, SMALL_TURRET_SKILL_IDS)
            const isSmallMissile = (m.effectIDs.has(9) || m.effectIDs.has(101))
                && itemRequiresSkillOneOf(m, SMALL_MISSILE_SKILL_IDS)
            if (isSmallTurret) {
                m.addAffliction(64 /* damageMultiplier */, aff)
            } else if (isSmallMissile && m.charge) {
                for (const attr of damageAttrs) m.charge.addAffliction(attr, aff)
            }
        }
    }

    // Module duration bonus (attr 66 — Omni Effect Beacon, -50 %).
    // System-wide module-cycle scaling. PostPercent on attrs 73
    // (`duration`) and 51 (`speed` / rate-of-fire). Negative values
    // shorten cycles (more DPS / more reps).
    const durationBonus = beaconAttrs.get(66) ?? 0
    if (durationBonus !== 0) {
        const aff = {
            sourceKind: 'module' as const,
            sourceID,
            operation: 'PostPercent' as const,
            value: durationBonus / 100,
            stackingGroup: null,
        }
        for (const m of ctx.modules) {
            m.addAffliction(73, aff)
            m.addAffliction(51, aff)
        }
    }
}

// =============================================================================
// Capital Drone Speed Augmentor (effect 6671) is fully data-driven via SDE
// modifierInfo on the module typeIDs (33297/33298): ItemModifier (shipID, attr
// 1138 → 48) for the CPU drawback + two OwnerRequiredSkillModifier entries
// (Drones 3436 / Light Drone Operation 23069, attr 591 → 37) for the drone
// velocity bonus. The previous hand-rolled handler read attrs 2055/5004 which
// don't exist on the modules — so it produced nothing, while the generic
// dispatcher correctly applied the SDE-described modifiers. Removed as dead
// code on 2026-05-03.
// =============================================================================

// =============================================================================
// Fighter ability self-modifiers — effects 6440 / 6441 / 6439.
//
// Each one modifies the FIGHTER's own attributes (max velocity, sig radius,
// shield resonances) when the ability is "active". Pyfa runs them at
// `runtime='late'` so they read fully-modified base values.
//
// Effect 6440 (Afterburner, used by Shadow / Siren families): boosts
// `maxVelocity` by `fighterAbilityAfterburnerSpeedBonus` (PostPercent, stack
// penalised).
//
// Effect 6441 (MicroWarpDrive, used by 51 Light / Heavy / Support fighter
// types): boosts `maxVelocity` by `fighterAbilityMicroWarpDriveSpeedBonus`
// AND `signatureRadius` by `fighterAbilityMicroWarpDriveSignatureRadiusBonus`,
// both PostPercent + stack penalised.
//
// Effect 6439 (Evasive Maneuvers, used by Light / Structure Light fighters):
// boosts `maxVelocity` by `fighterAbilityEvasiveManeuversSpeedBonus`
// (un-stacked per Pyfa — note the comment says "may not have stacking
// penalties, but there's nothing else that affects the attributes yet to
// check"; we use stack penalised for safety since other handlers above
// (e.g. CapitalDroneSpeedAug) may also write maxVelocity), boosts
// `signatureRadius` by the corresponding sig bonus (stack penalised), and
// multiplies the four shield resonances by the per-flavour resonance
// multipliers (stack penalised).
//
// All three abilities are gated as "always on" for fighter cards — Pyfa
// exposes per-ability toggle but our derived stats display assumes
// fully-active when the fighter is in the squadron. Squadron count does NOT
// scale these (per-fighter self-mods).
//
// Audit: 13 fighter ability effects, ~262 type references. Without these the
// fighter cards in the UI underreport speed / sig and over-report incoming
// damage on Light fighters in evasive mode.
// =============================================================================

const FIGHTER_AB_EFFECT_ID  = 6440
const FIGHTER_MWD_EFFECT_ID = 6441
const FIGHTER_EVASIVE_EFFECT_ID = 6439

const ATTR_FIGHTER_AB_SPEED_BONUS  = 2151
const ATTR_FIGHTER_MWD_SPEED_BONUS = 2152
const ATTR_FIGHTER_MWD_SIG_BONUS   = 2153
const ATTR_FIGHTER_EVASIVE_SPEED_BONUS = 2224
const ATTR_FIGHTER_EVASIVE_SIG_BONUS   = 2225
const ATTR_FIGHTER_EVASIVE_EM_RES   = 2118
const ATTR_FIGHTER_EVASIVE_THM_RES  = 2119
const ATTR_FIGHTER_EVASIVE_KIN_RES  = 2120
const ATTR_FIGHTER_EVASIVE_EXP_RES  = 2121

const ATTR_SHIELD_EM_RESO   = 271
const ATTR_SHIELD_EXP_RESO  = 272
const ATTR_SHIELD_KIN_RESO  = 273
const ATTR_SHIELD_THM_RESO  = 274

export function applyLegacyFighterAbilities(ctx: FitContext): void {
    for (const fighter of ctx.fighters) {
        // Effect 6440 — Afterburner (subset of fighters).
        if (fighter.effectIDs.has(FIGHTER_AB_EFFECT_ID)) {
            const speedPct = fighter.getFinal(ATTR_FIGHTER_AB_SPEED_BONUS, 0)
            if (speedPct !== 0) {
                fighter.addAffliction(ATTR_MAX_VELOCITY, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostPercent',
                    value: speedPct / 100,
                    stackingGroup: `attr:${ATTR_MAX_VELOCITY}`,
                })
            }
        }

        // Effect 6441 — MicroWarpDrive (most fighters).
        if (fighter.effectIDs.has(FIGHTER_MWD_EFFECT_ID)) {
            const speedPct = fighter.getFinal(ATTR_FIGHTER_MWD_SPEED_BONUS, 0)
            if (speedPct !== 0) {
                fighter.addAffliction(ATTR_MAX_VELOCITY, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostPercent',
                    value: speedPct / 100,
                    stackingGroup: `attr:${ATTR_MAX_VELOCITY}`,
                })
            }
            const sigPct = fighter.getFinal(ATTR_FIGHTER_MWD_SIG_BONUS, 0)
            if (sigPct !== 0) {
                fighter.addAffliction(ATTR_SIGNATURE_RADIUS, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostPercent',
                    value: sigPct / 100,
                    stackingGroup: `attr:${ATTR_SIGNATURE_RADIUS}`,
                })
            }
        }

        // Effect 6439 — Evasive Maneuvers (light fighters only).
        if (fighter.effectIDs.has(FIGHTER_EVASIVE_EFFECT_ID)) {
            const speedPct = fighter.getFinal(ATTR_FIGHTER_EVASIVE_SPEED_BONUS, 0)
            if (speedPct !== 0) {
                fighter.addAffliction(ATTR_MAX_VELOCITY, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostPercent',
                    value: speedPct / 100,
                    stackingGroup: `attr:${ATTR_MAX_VELOCITY}`,
                })
            }
            const sigPct = fighter.getFinal(ATTR_FIGHTER_EVASIVE_SIG_BONUS, 0)
            if (sigPct !== 0) {
                fighter.addAffliction(ATTR_SIGNATURE_RADIUS, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostPercent',
                    value: sigPct / 100,
                    stackingGroup: `attr:${ATTR_SIGNATURE_RADIUS}`,
                })
            }
            // Resonance multipliers: SDE encodes them as `0.95` etc. (already
            // a multiplier, NOT a percent), so apply via PostMul. Pyfa uses
            // `multiplyItemAttr` which is exactly PostMul.
            const resonances: Array<readonly [number, number]> = [
                [ATTR_FIGHTER_EVASIVE_EM_RES,  ATTR_SHIELD_EM_RESO],
                [ATTR_FIGHTER_EVASIVE_THM_RES, ATTR_SHIELD_THM_RESO],
                [ATTR_FIGHTER_EVASIVE_KIN_RES, ATTR_SHIELD_KIN_RESO],
                [ATTR_FIGHTER_EVASIVE_EXP_RES, ATTR_SHIELD_EXP_RESO],
            ]
            for (const [srcAttr, tgtAttr] of resonances) {
                const mul = fighter.getFinal(srcAttr, 0)
                if (mul === 0 || mul === 1) continue
                fighter.addAffliction(tgtAttr, {
                    sourceKind: 'fighter',
                    sourceID: fighter.id,
                    operation: 'PostMul',
                    value: mul,
                    stackingGroup: `attr:${tgtAttr}`,
                })
            }
        }
    }
}

// =============================================================================
// Triglavian Entropic Disintegrator spool-up — effect 6995.
// Each cycle the weapon's damageMultiplier increases by a fixed fraction of
// the base, capped at a maximum bonus. Pyfa exposes a global "spool %"
// 0..1 that scales the bonus from 0 (cold start) to max. Time-to-full-spool
// (in seconds) = ceil(bonusMax / bonusPerCycle) × cycleTime.
//
// Attribute IDs:
//   - 64   damageMultiplier
//   - 2733 damageMultiplierBonusPerCycle (e.g. 0.07 = 7 % per cycle)
//   - 2734 damageMultiplierBonusMax      (e.g. 2.125 = +212.5 % at full)
// =============================================================================

const DISINTEGRATOR_EFFECT_ID = 6995
// `ATTR_DAMAGE_MULTIPLIER = 64` is already declared above near the
// command-burst handler; reusing that const here.
const ATTR_DMG_MULT_BONUS_PER_CYCLE  = 2733
const ATTR_DMG_MULT_BONUS_MAX        = 2734

/** Compute current spool damage bonus (fractional, e.g. 1.5 means +150 %).
 *  Caller-side helper for UI breakdowns; engine-side application uses the
 *  same math via `applyLegacyDisintegratorSpool`. */
export function disintegratorSpoolBonus(maxBonus: number, spoolPercent: number): number {
    if (maxBonus <= 0) return 0
    const p = Math.max(0, Math.min(1, spoolPercent))
    return maxBonus * p
}

/** Cycles needed to reach full spool — ceil(max / perCycle). Returns 0 when
 *  the weapon has no spool-up (e.g. attrs missing). */
export function disintegratorCyclesToFullSpool(maxBonus: number, bonusPerCycle: number): number {
    if (maxBonus <= 0 || bonusPerCycle <= 0) return 0
    return Math.ceil(maxBonus / bonusPerCycle)
}

/**
 * Apply the spool-up bonus to every fitted disintegrator's damageMultiplier.
 * The bonus is `spoolPercent × max`. Implemented as a PostPercent affliction
 * so the existing offense pipeline picks it up via `module.getFinal(64)`
 * without a special-case in the DPS calculator.
 *
 * Runs AFTER applySkills/applyModules so the base multiplier already reflects
 * Disintegrator Specialization, ship bonuses, etc., and the spool layers on
 * top multiplicatively — the same way Pyfa applies it as a final stage.
 */
export function applyLegacyDisintegratorSpool(ctx: FitContext, spoolPercent: number): void {
    const p = Math.max(0, Math.min(1, spoolPercent))
    if (p <= 0) return
    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(DISINTEGRATOR_EFFECT_ID)) continue
        // Read the FULLY-MODIFIED max bonus, not the SDE base. Marauder
        // platforms (Babaroga effect 12288) boost the disintegrator's
        // `damageMultiplierBonusMax` (attr 2734) by +20 %/level of Large
        // Precursor Weapon — at V, base 2.125 → 4.25. Reading getBase
        // would silently halve the spool ceiling.
        if (!mod.hasAttr(ATTR_DMG_MULT_BONUS_MAX)) continue
        const maxBonus = mod.getFinal(ATTR_DMG_MULT_BONUS_MAX, 0)
        if (maxBonus <= 0) continue
        mod.addAffliction(ATTR_DAMAGE_MULTIPLIER, {
            sourceKind: 'module',
            sourceID: mod.id,
            operation: 'PostPercent',
            value: p * maxBonus,
            stackingGroup: null,
        })
    }
}

// =============================================================================
// Reactive Armor Hardener (RAH) — effect 4928, dynamic adaptation loop.
// =============================================================================

/** RAH effect ID. Verified against Pyfa Effect4928. */
const RAH_EFFECT_ID = 4928

/**
 * Reactive Armor Hardener dynamic adaptation. RAHs cycle through
 * resistance distributions, shifting strongest resonance towards the
 * incoming damage type. Without this, an armor fit's EHP-vs-profile is
 * computed against the static base resonances — wildly wrong for any
 * fit running RAH.
 *
 * Algorithm (Pyfa-parity, eos/effects.py Effect4928):
 *   1. Read the four armor resonance values from the RAH module — these
 *      are the per-cycle SHIFT magnitudes (NOT the steady-state resonance).
 *   2. Read `resistanceShiftAmount` (attr 1849) — divides by 100 to get
 *      the per-cycle fraction (typically 0.06 = 6 %).
 *   3. Compute the damage-weighted resonance after multiplying ship's
 *      current resonances by the damage-profile weights.
 *   4. Iterate up to 50 cycles: at each step, sort damage taken across
 *      the four types, push resists towards the strongest two (or all
 *      four if symmetric).
 *   5. Detect the equilibrium loop (resistances repeat within tolerance).
 *   6. Average the loop's resonance values.
 *   7. Push a stack-penalised PostMul affliction on each ship resonance
 *      attribute with the averaged value.
 */
export function applyLegacyRAH(
    ctx: FitContext,
    damageProfile: { em: number; thermal: number; kinetic: number; explosive: number } | null,
): void {
    if (!damageProfile) return
    if (damageProfile.em + damageProfile.thermal + damageProfile.kinetic + damageProfile.explosive <= 0) return

    for (const mod of ctx.modules) {
        if (mod.state !== 'ACTIVE' && mod.state !== 'OVERLOAD') continue
        if (!mod.effectIDs.has(RAH_EFFECT_ID)) continue

        const ship = ctx.ship
        const baseDamageTaken = [
            damageProfile.em        * ship.getFinal(ATTR_ARMOR_EM_RES,    1),
            damageProfile.thermal   * ship.getFinal(ATTR_ARMOR_THERM_RES, 1),
            damageProfile.kinetic   * ship.getFinal(ATTR_ARMOR_KIN_RES,   1),
            damageProfile.explosive * ship.getFinal(ATTR_ARMOR_EXP_RES,   1),
        ]

        const resistanceShift = (mod.getFinal(ATTR_RAH_RESISTANCE_SHIFT, 0) || 6) / 100

        // Initial RAH resonances (per-cycle shift magnitudes, unmodified
        // by the ship — this is the RAH module's own armor*Resonance attrs).
        const rahResistance = [
            mod.getBase(ATTR_ARMOR_EM_RES)    ?? 1,
            mod.getBase(ATTR_ARMOR_THERM_RES) ?? 1,
            mod.getBase(ATTR_ARMOR_KIN_RES)   ?? 1,
            mod.getBase(ATTR_ARMOR_EXP_RES)   ?? 1,
        ]

        const cycles: number[][] = []
        let loopStart = -1
        for (let cycle = 0; cycle < 50; cycle++) {
            const tuples: [number, number, number][] = [
                [0, baseDamageTaken[0]! * rahResistance[0]!, rahResistance[0]!],
                [3, baseDamageTaken[3]! * rahResistance[3]!, rahResistance[3]!],
                [2, baseDamageTaken[2]! * rahResistance[2]!, rahResistance[2]!],
                [1, baseDamageTaken[1]! * rahResistance[1]!, rahResistance[1]!],
            ]
            tuples.sort((a, b) => a[1] - b[1])

            let change0: number, change1: number, change2: number, change3: number
            if (tuples[2]![1] === 0) {
                // One damage type — the top type takes from the other three
                change0 = 1 - tuples[0]![2]
                change1 = 1 - tuples[1]![2]
                change2 = 1 - tuples[2]![2]
                change3 = -(change0 + change1 + change2)
            } else if (tuples[1]![1] === 0) {
                // Two damage types — top two take equally from the other two
                change0 = 1 - tuples[0]![2]
                change1 = 1 - tuples[1]![2]
                change2 = -(change0 + change1) / 2
                change3 = -(change0 + change1) / 2
            } else {
                change0 = Math.min(resistanceShift, 1 - tuples[0]![2])
                change1 = Math.min(resistanceShift, 1 - tuples[1]![2])
                change2 = -(change0 + change1) / 2
                change3 = -(change0 + change1) / 2
            }

            rahResistance[tuples[0]![0]] = tuples[0]![2] + change0
            rahResistance[tuples[1]![0]] = tuples[1]![2] + change1
            rahResistance[tuples[2]![0]] = tuples[2]![2] + change2
            rahResistance[tuples[3]![0]] = tuples[3]![2] + change3

            // Detect a stable cycle.
            const tolerance = 1e-6
            for (let i = 0; i < cycles.length; i++) {
                const v = cycles[i]!
                if (
                    Math.abs(rahResistance[0]! - v[0]!) <= tolerance
                    && Math.abs(rahResistance[1]! - v[1]!) <= tolerance
                    && Math.abs(rahResistance[2]! - v[2]!) <= tolerance
                    && Math.abs(rahResistance[3]! - v[3]!) <= tolerance
                ) {
                    loopStart = i
                    break
                }
            }
            if (loopStart >= 0) break
            cycles.push([...rahResistance])
        }

        // Average the loop (or the last 20 if we didn't converge).
        const loopCycles = loopStart >= 0
            ? cycles.slice(loopStart)
            : cycles.slice(Math.max(0, cycles.length - 20))
        if (loopCycles.length === 0) continue
        const avg = [0, 0, 0, 0]
        for (const c of loopCycles) {
            avg[0]! += c[0]!
            avg[1]! += c[1]!
            avg[2]! += c[2]!
            avg[3]! += c[3]!
        }
        for (let i = 0; i < 4; i++) avg[i] = avg[i]! / loopCycles.length

        // Push the averaged multipliers onto the ship's armor resonances.
        //
        // Pyfa-parity: applied as `PreMul` (Pyfa's `Effect4928` calls
        // `boostItemAttrIncrease(..., position='preMul', stackingPenalties=True)`).
        // Critical because PreMul shares the stacking pool with the DCU's
        // PreMul resonance bonus — RAH and DCU compete in one penalty
        // stack while membranes (PostPercent) live in their own. Without
        // this, after PostMul/PostPercent are split into separate pools
        // (Moros parity fix), RAH would apply unstacked vs membranes,
        // overshooting Pyfa's armor resists by ~0.4 pp on every fit
        // running RAH (Legion: 82.6 % thermal vs Pyfa 82.2 %).
        const targets: ReadonlyArray<readonly [number, number]> = [
            [avg[0]!, ATTR_ARMOR_EM_RES],
            [avg[1]!, ATTR_ARMOR_THERM_RES],
            [avg[2]!, ATTR_ARMOR_KIN_RES],
            [avg[3]!, ATTR_ARMOR_EXP_RES],
        ]
        for (const [factor, tgtAttr] of targets) {
            ctx.ship.addAffliction(tgtAttr, {
                sourceKind: 'module',
                sourceID: mod.id,
                operation: 'PreMul',
                value: factor,
                stackingGroup: `attr:${tgtAttr}`,
            })
        }
    }
}

// =============================================================================
// T3C subsystem slot/hardpoint pass — already covered.
// =============================================================================

/**
 * T3C subsystem attribute IDs that grant slot / hardpoint bonuses to the
 * fitted ship. These are stored as plain numeric attributes on each
 * subsystem (NOT through `modifierInfo`), so the generic dispatcher can't
 * pick them up. Pyfa hardcodes the mapping; we mirror it here.
 *
 *   1368 → turret hardpoints  (e.g. Legion Offensive - Liquid Crystal +6)
 *   1369 → launcher hardpoints (e.g. Legion Offensive - Assault Opt +5)
 *   1374 → high slots
 *   1375 → med slots
 *   1376 → low slots
 *
 * Without this, T3C ships report 0 high/med/low slots and 0 hardpoints —
 * every module slot disappears from the editor.
 */
const SUBSYSTEM_SLOT_BONUS_MAP: ReadonlyArray<readonly [number, number]> = [
    [1368, /* TURRET_HARDPOINTS    */ 102],
    [1369, /* LAUNCHER_HARDPOINTS  */ 101],
    [1374, /* HI_SLOTS             */ 14],
    [1375, /* MED_SLOTS            */ 13],
    [1376, /* LOW_SLOTS            */ 12],
]

export function applyLegacySubsystemSlots(ctx: FitContext): void {
    for (const sub of ctx.subsystems) {
        for (const [sourceAttr, targetAttr] of SUBSYSTEM_SLOT_BONUS_MAP) {
            const bonus = sub.getBase(sourceAttr) ?? 0
            if (bonus === 0) continue
            ctx.ship.addAffliction(targetAttr, {
                sourceKind: 'subsystem',
                sourceID: sub.id,
                operation: 'ModAdd',
                value: bonus,
                stackingGroup: null,  // subsystems bypass stacking penalty
            })
        }
        // T3C subsystem mass is NOT added to the hull mass — Pyfa-parity
        // verified by reversing AB boost on a Legion: speedFactor 145 ×
        // Acceleration Control V (× 1.25) × thrust 15M / mass = 1.283 boost
        // ⇔ mass ≈ 21.2M kg, matching base 14.5M + AB +5M + Plates +1.7M
        // (NO subsystem contribution). Adding subsystem masses pushes mass
        // to ~26M and velocity falls 10 % short of Pyfa.
    }
}

/**
 * Subsystem "*AddPassive" effects: flat HP/cap/cargo additions a subsystem
 * grants to its parent ship. The SDE wires these via `modifierInfo` with
 * `func: ItemModifier, op: ModAdd, domain: shipID`, but in practice the
 * generic dispatcher does NOT pick them up reliably on T3C subsystems —
 * Pyfa parity testing on a Legion + Covert Reconfiguration produced a
 * 1.7k EHP shortfall (missing +300 shield + +600 hull HP).
 *
 * To guarantee parity we replicate Pyfa's hardcoded handlers here. Each
 * row says "if the subsystem carries effect E, read its attr S and add it
 * to the ship's attr T". The corresponding effect IDs are listed in
 * LEGACY_HANDLED_PASSIVE_ADD_EFFECTS so applySourceItem skips them and we
 * don't double-apply.
 *
 * Verified against:
 *   - SDE `dogmaEffects.jsonl` modifierInfo for each effect ID
 *   - Pyfa effect handlers `effect3831`, `effect3771`, `effect6920`,
 *     `effect3810`, `effect3811`, `effect3808`
 *   - Legion + 4× HAM Launcher fit with all skills V → 18.6k EHP total.
 */
const SUBSYSTEM_ADD_PASSIVE_EFFECTS: ReadonlyArray<readonly [number, number, number, string]> = [
    // [effectID, sourceAttrID, targetAttrID, label-for-debug]
    [3831, 263,  263, 'shieldCapacity'],   // shieldCapacityAddPassive
    [3771, 1159, 265, 'armorHP'],          // armorHPBonusAddPassive
    [6920, 2688, 9,   'structureHP'],      // structureHPBonusAddPassive
    [3810, 2689, 38,  'cargoCapacity'],    // capacityAddPassive
    [3811, 482,  482, 'capacitorCapacity'],// capacitorCapacityAddPassive
    [3808, 552,  552, 'signatureRadius'],  // signatureRadiusAddPassive
]

const LEGACY_HANDLED_PASSIVE_ADD_EFFECTS: ReadonlySet<number> = new Set(
    SUBSYSTEM_ADD_PASSIVE_EFFECTS.map(([eid]) => eid),
)

export function applyLegacySubsystemAddPassive(ctx: FitContext): void {
    for (const sub of ctx.subsystems) {
        for (const [effectID, srcAttr, tgtAttr] of SUBSYSTEM_ADD_PASSIVE_EFFECTS) {
            if (!sub.effectIDs.has(effectID)) continue
            const value = sub.getBase(srcAttr) ?? 0
            if (value === 0) continue
            ctx.ship.addAffliction(tgtAttr, {
                sourceKind: 'subsystem',
                sourceID: sub.id,
                operation: 'ModAdd',
                value,
                stackingGroup: null,  // subsystems bypass stacking penalty
            })
        }
    }
}

/** Effect IDs claimed by hardcoded legacy handlers — the generic
 *  modifier dispatcher skips these to avoid double-application.
 *
 *  Bastion (6658) has 49 modifierInfo entries in modern SDE that
 *  duplicate what `applyLegacyBastion` does — applying both compounded
 *  the resonance bonus (e.g. shield em PreMul × PostMul of 0.7 each →
 *  0.49 effective instead of Pyfa's 0.7). Skipping the generic path
 *  restores parity. */
const LEGACY_HANDLED_HARDCODED_EFFECTS: ReadonlySet<number> = new Set([
    6658,  // Bastion Module — applyLegacyBastion
])

/** Effects whose magnitude pyfa scales by the pilot's security status
 *  (`bonus = attr × getPilotSecurity()`), used by Alliance-Tournament frigates.
 *  The default character has sec status 0 → the bonus is 0. We don't model
 *  pilot sec status, so we skip these (apply 0), matching pyfa's default pilot.
 *  Derived from pyfa eos/effects.py handlers calling `getPilotSecurity`. */
export const SEC_STATUS_SCALED_EFFECT_IDS: ReadonlySet<number> = new Set([
    6871, 12165, 12181, 12185, 12202,
])

export const LEGACY_HANDLED_EFFECT_IDS: ReadonlySet<number> = new Set([
    ...LEGACY_HANDLED_PASSIVE_ADD_EFFECTS,
    ...LEGACY_HANDLED_HARDCODED_EFFECTS,
])

/**
 * Skill-effect target resolver. Skills typically use:
 *  - `OwnerRequiredSkillModifier` → all items requiring this skill
 *  - `LocationRequiredSkillModifier` (on shipID) → all ship-mounted items
 *    requiring this skill
 *  - `ItemModifier` on `char` or `shipID` → flat bonus to char/ship attr
 */
function resolveSkillTargets(mi: SdeModifierInfo, ctx: FitContext): ItemState[] {
    // For skill effects we use the same FitContext logic but supply the
    // character as the source so 'self' / 'char' resolve correctly.
    return ctx.targetsForModifier(mi, ctx.character)
}
