/**
 * Offense aggregation — turret + missile + smart-bomb + drone DPS.
 *
 * For each fitted module + active drone we:
 *   1. Classify it as a weapon (effects/weapon.ts)
 *   2. Read damage components from the right source (charge for turrets +
 *      missiles, item itself for smart bombs + drones)
 *   3. Compute raw DPS = (sum_damage × damageMultiplier) / cycle_seconds
 *   4. Compute reload-aware sustained DPS by amortising the per-load
 *      damage volley over (cycles_in_load + reload_seconds). When no
 *      charge or reload time, sustained equals peak.
 *
 * Reload model:
 *   - Modules with effect 10/34/67/101/6995 (Pyfa-parity legacy reload
 *     effects) get a 1000 ms default reload when no `reloadTime` attribute.
 *   - Charges-per-load = floor(launcher.capacity / charge.volume) for
 *     weapons; for cap boosters Pyfa uses the same formula.
 *   - Time-per-load = chargesPerLoad × cycleSeconds + reloadSeconds.
 *   - Sustained DPS = (chargesPerLoad × alpha) / timePerLoad.
 *
 * What's intentionally still simplified:
 *   - No tracking application: turret tracking against target velocity /
 *     sig would multiply DPS by hit-quality < 1. We expose tracking +
 *     range attributes so the UI can show them, but DPS reported is the
 *     optimal-range no-tracking-loss baseline.
 *   - No DRF application for missiles: same reasoning.
 *   - Drone control range / EWAR projection / fighter ability cooldowns:
 *     all stubbed.
 *   - Resists vs damage profile: not applied here; the offense view shows
 *     RAW damage components, the defense view shows EHP-vs-profile.
 */

import { ATTR } from '../constants'
import type { FitContext } from '../fitContext'
import type { ItemState } from '../itemState'
import type { FittingDataset, SdeEffect, WeaponContribution } from '../types'
import {
    classifyWeapon,
    readCycleInfo,
    readDamageComponents,
    readRangeInfo,
    type WeaponDamageComponents,
} from '../effects/weapon'

export type { WeaponContribution } from '../types'

export interface OffenseReport {
    weaponDps: number
    /** Reload-amortised weapon DPS — for short-magazine weapons (lasers,
     *  cap boosters) this is meaningfully lower than `weaponDps`. */
    weaponSustainedDps: number
    droneDps: number
    fighterDps: number
    totalDps: number
    totalSustainedDps: number
    /** Single-volley alpha across all weapons (no synchronization assumed —
     *  this is "if every gun fired right now, total damage applied"). */
    alphaStrike: number
    /** Effective optimal range — minimum of any weapon's optimal that
     *  contributes meaningful DPS. UI calls it "max engagement range". */
    weaponOptimal: number
    weaponFalloff: number
    weaponTracking?: number
    explosionVelocity?: number
    explosionRadius?: number
    /** Missile max flight range (m) — modified velocity × flight time. The
     *  missile equivalent of `weaponOptimal`. Undefined for non-missile fits. */
    missileRange?: number
    breakdown: WeaponContribution[]
}

/** Effects that signal "this module reloads in 1 second" per Pyfa-parity
 *  legacy handlers (Effect10/34/67/101/6995). Used as a fallback when the
 *  module type doesn't carry an explicit `reloadTime` attribute. */
const LEGACY_RELOAD_1S_EFFECT_IDS: ReadonlySet<number> = new Set([
    10, 34, 67, 101, 6995,
])
const ATTR_RELOAD_TIME = 1795
const ATTR_CAPACITY    = 38
const ATTR_VOLUME      = 161

export function computeOffense(
    ctx: FitContext,
    dataset: FittingDataset,
    fit: {
        drones: Array<{ id: string; typeID: number; countTotal: number; countActive: number }>
        fighters?: Array<{ id: string; typeID: number; count: number; abilityState?: Record<number, boolean> }>
    },
): OffenseReport {
    const breakdown: WeaponContribution[] = []
    let weaponDps = 0
    let weaponSustainedDps = 0
    let droneDps = 0
    let fighterDps = 0
    let alphaStrike = 0

    // Modules: turrets, missile launchers, smart bombs.
    // Identical weapons (same typeID + chargeTypeID + state + cycle) are
    // grouped into a single breakdown row with `count`, mirroring how
    // drones get rendered as "Vespa II ×N". Per-row DPS / alpha report
    // the GROUP totals so the user sees the contribution of each weapon
    // family at a glance instead of N near-identical rows.
    const weaponGroups = new Map<string, WeaponContribution>()
    for (const m of ctx.modules) {
        if (m.state !== 'ACTIVE' && m.state !== 'OVERLOAD') continue
        const contribution = weaponContributionFor(m, ctx, dataset)
        if (!contribution) continue
        weaponDps += contribution.dps
        weaponSustainedDps += contribution.sustainedDps ?? contribution.dps
        alphaStrike += contribution.alpha
        const key = `${contribution.typeID}|${contribution.chargeTypeID ?? '-'}|${m.state}|${contribution.cycleSeconds.toFixed(3)}`
        const existing = weaponGroups.get(key)
        if (existing) {
            existing.dps += contribution.dps
            existing.alpha += contribution.alpha
            if (existing.sustainedDps != null && contribution.sustainedDps != null) {
                existing.sustainedDps += contribution.sustainedDps
            }
            if (existing.chainDpsMax != null && contribution.chainDpsMax != null) {
                existing.chainDpsMax += contribution.chainDpsMax
            }
            existing.damages = {
                em: existing.damages.em + contribution.damages.em,
                thermal: existing.damages.thermal + contribution.damages.thermal,
                kinetic: existing.damages.kinetic + contribution.damages.kinetic,
                explosive: existing.damages.explosive + contribution.damages.explosive,
                total: existing.damages.total + contribution.damages.total,
            }
            existing.count += 1
        } else {
            weaponGroups.set(key, { ...contribution, count: 1 })
        }
    }
    for (const row of weaponGroups.values()) breakdown.push(row)

    // Drones: classify the same way; the drone item carries damage attrs.
    // Aggregate per-drone DPS × countActive (only flying drones contribute).
    const fitDronesByItemId = new Map(fit.drones.map(d => [d.id, d]))
    for (const droneItem of ctx.drones) {
        const fd = fitDronesByItemId.get(droneItem.id)
        if (!fd || fd.countActive <= 0) continue
        const contribution = droneContributionFor(droneItem, fd.countActive, ctx, dataset)
        if (!contribution) continue
        breakdown.push(contribution)
        droneDps += contribution.dps
        alphaStrike += contribution.alpha
    }

    // Fighters: dedicated handler reads fighter-specific damage attrs
    // (fighterAbilityAttackMissile* + fighterAbilityMissiles*) and
    // multiplies by squadron count. Each fighter type may have multiple
    // attack abilities; sum them all into a single contribution row.
    const fitFightersByItemId = new Map((fit.fighters ?? []).map(f => [f.id, f]))
    for (const fighterItem of ctx.fighters) {
        const ff = fitFightersByItemId.get(fighterItem.id)
        if (!ff || ff.count <= 0) continue
        const contribution = fighterContributionFor(fighterItem, ff.count, ctx, dataset)
        if (!contribution) continue
        breakdown.push(contribution)
        fighterDps += contribution.dps
        alphaStrike += contribution.alpha
    }

    // Range aggregates — pick the tightest engagement envelope so the UI
    // can warn "your rapid lights drop off at X km". For mixed loadouts
    // this is just the minimum optimal (still useful as a worst-case).
    const turretContribs = breakdown.filter(b => b.kind === 'TURRET')
    const missileContribs = breakdown.filter(b => b.kind === 'MISSILE')

    const weaponOptimal = turretContribs.length > 0
        ? Math.min(...turretContribs.map(c => c.range.optimal).filter(v => v > 0))
        : 0
    const weaponFalloff = turretContribs.length > 0
        ? Math.min(...turretContribs.map(c => c.range.falloff).filter(v => v > 0))
        : 0
    const weaponTracking = turretContribs.length > 0
        ? Math.min(...turretContribs.map(c => c.range.tracking).filter(v => v > 0))
        : undefined

    const explosionVelocity = missileContribs.length > 0
        ? missileContribs[0]!.range.explosionVelocity
        : undefined
    const explosionRadius = missileContribs.length > 0
        ? missileContribs[0]!.range.explosionRadius
        : undefined
    const missileRange = missileContribs.length > 0
        ? Math.max(...missileContribs.map(c => c.range.flightRange).filter(v => v > 0))
        : undefined

    return {
        weaponDps,
        weaponSustainedDps,
        droneDps,
        fighterDps,
        totalDps: weaponDps + droneDps + fighterDps,
        totalSustainedDps: weaponSustainedDps + droneDps + fighterDps,
        alphaStrike,
        weaponOptimal: Number.isFinite(weaponOptimal) ? weaponOptimal : 0,
        weaponFalloff: Number.isFinite(weaponFalloff) ? weaponFalloff : 0,
        weaponTracking,
        explosionVelocity,
        explosionRadius,
        missileRange: missileRange != null && Number.isFinite(missileRange) ? missileRange : undefined,
        breakdown,
    }
}

/** Fighter damage contribution. Reads the two fighter attack ability
 *  attribute families (primary turret + missile/secondary) and sums
 *  per-squadron DPS. Pyfa-parity: for each ability the engine multiplies
 *  the four damage components by `damageMultiplier`, divides by
 *  `duration`, then scales by squadron count. */
function fighterContributionFor(
    fighter: ItemState,
    count: number,
    _ctx: FitContext,
    dataset: FittingDataset,
): WeaponContribution | null {
    // Primary attack (effect 6465 fighterAbilityAttackM) — turret-style
    // damage. Secondary missile attack (effect 6431 fighterAbilityMissiles)
    // — missile-style damage. A fighter may carry one or both.
    let totalAlpha = 0
    let totalDps = 0
    let primaryCycle = 0
    const damages = { em: 0, thermal: 0, kinetic: 0, explosive: 0, total: 0 }

    // Primary turret attack (attrs 2227-2230 + multiplier 2226 + duration 2233).
    if (fighter.effectIDs.has(6465)) {
        const em   = fighter.getFinal(2227, 0)
        const thm  = fighter.getFinal(2228, 0)
        const kin  = fighter.getFinal(2229, 0)
        const exp  = fighter.getFinal(2230, 0)
        const mult = fighter.getFinal(2226, 1)
        const durMs = fighter.getFinal(2233, 0)
        if (durMs > 0) {
            const sumDmg = em + thm + kin + exp
            const alpha = sumDmg * mult * count
            const dps = alpha / (durMs / 1000)
            totalAlpha += alpha
            totalDps += dps
            damages.em += em * mult * count
            damages.thermal += thm * mult * count
            damages.kinetic += kin * mult * count
            damages.explosive += exp * mult * count
            damages.total += sumDmg * mult * count
            primaryCycle = durMs / 1000
        }
    }
    // Missile/secondary attack (attrs 2131-2134 + multiplier 2130 + duration 2233).
    // The duration is shared with primary in modern SDE; if a separate
    // missile cycle attribute is needed, refine here.
    if (fighter.effectIDs.has(6431)) {
        const em   = fighter.getFinal(2131, 0)
        const thm  = fighter.getFinal(2132, 0)
        const kin  = fighter.getFinal(2133, 0)
        const exp  = fighter.getFinal(2134, 0)
        const mult = fighter.getFinal(2130, 1)
        const durMs = fighter.getFinal(2233, 0)
        if (durMs > 0) {
            const sumDmg = em + thm + kin + exp
            const alpha = sumDmg * mult * count
            const dps = alpha / (durMs / 1000)
            totalAlpha += alpha
            totalDps += dps
            damages.em += em * mult * count
            damages.thermal += thm * mult * count
            damages.kinetic += kin * mult * count
            damages.explosive += exp * mult * count
            damages.total += sumDmg * mult * count
            if (primaryCycle === 0) primaryCycle = durMs / 1000
        }
    }

    if (totalDps === 0) return null

    return {
        sourceID: fighter.id,
        typeID: fighter.typeID,
        kind: 'DRONE',  // re-use the DRONE kind for breakdown rendering
        alpha: totalAlpha,
        dps: totalDps,
        cycleSeconds: primaryCycle,
        damages,
        range: {
            optimal: fighter.getFinal(2236, 0),  // attack missile range optimal
            falloff: fighter.getFinal(2237, 0),
            tracking: 0,
            burstRange: 0,
            explosionRadius: fighter.getFinal(2125, 0),
            explosionVelocity: fighter.getFinal(2126, 0),
            drf: fighter.getFinal(2127, 0),
            flightRange: 0,
        },
        count,
    }
}

function readReloadInfo(module: ItemState): { reloadSeconds: number; chargesPerLoad: number } {
    // Reload time — explicit attribute first, fallback to legacy 1 s default
    // for known weapon effects.
    let reloadMs = module.getFinal(ATTR_RELOAD_TIME, 0)
    if (reloadMs <= 0) {
        for (const eid of LEGACY_RELOAD_1S_EFFECT_IDS) {
            if (module.effectIDs.has(eid)) { reloadMs = 1000; break }
        }
    }
    const reloadSeconds = reloadMs / 1000

    // Charges per load — capacity / charge volume. Falls back to 1 if
    // either value is missing (no reload modeled in that case).
    const charge = module.charge
    if (!charge) return { reloadSeconds: 0, chargesPerLoad: 1 }
    const capacity = module.getFinal(ATTR_CAPACITY, 0)
    const chargeVolume = charge.getFinal(ATTR_VOLUME, 0)
    if (capacity <= 0 || chargeVolume <= 0) return { reloadSeconds, chargesPerLoad: 1 }
    const chargesPerLoad = Math.floor(capacity / chargeVolume)
    return { reloadSeconds, chargesPerLoad: Math.max(1, chargesPerLoad) }
}

function computeSustainedDps(
    alpha: number,
    cycleSeconds: number,
    reloadSeconds: number,
    chargesPerLoad: number,
): number {
    if (cycleSeconds <= 0) return 0
    if (reloadSeconds <= 0 || chargesPerLoad <= 0) return alpha / cycleSeconds
    const damagePerLoad = chargesPerLoad * alpha
    const timePerLoad = chargesPerLoad * cycleSeconds + reloadSeconds
    return damagePerLoad / timePerLoad
}

// ---------------------------------------------------------------------------
// Per-source contribution builders
// ---------------------------------------------------------------------------

function weaponContributionFor(
    module: ItemState,
    ctx: FitContext,
    dataset: FittingDataset,
): WeaponContribution | null {
    const cls = classifyWeapon(module)
    if (!cls) return null
    const effect = dataset.effects.get(cls.effectID)
    if (!effect) return null

    // Breacher Pod (effect 12174 on the loaded charge): DOT weapon with no
    // em/therm/kin/exp damage attrs. Pyfa's `add_breacher` model — per
    // tick (1 s) damage = min(dotMaxDamagePerTick, dotMaxHPPercentagePerTick
    // × target.HP). We surface the cap as the steady-state DPS, matching
    // Pyfa's display when target HP is large enough that the cap binds
    // (i.e. all target HPs ≥ cap / pct). Skill bonuses (Breacher Pod
    // Launcher Operation V → +5%/level on attr 5737, Clone Efficacity V
    // → +5%/level on attr 5736, etc.) are already applied by the modifier
    // engine on the loaded charge.
    if (module.charge?.effectIDs.has(BREACHER_POD_EFFECT_ID)) {
        const cycle = readCycleInfo(module, cls.kind)
        return breacherContributionFor(module, cycle.cycleSeconds, effect, cls)
    }

    const damages = readDamageComponents(cls.damageSource)
    if (damages.total <= 0) {
        // Module is a weapon shape but has no ammo loaded → DPS 0 with a
        // placeholder breakdown so the UI can still flag the empty launcher.
        return {
            sourceID: module.id,
            typeID: module.typeID,
            kind: cls.kind,
            alpha: 0,
            dps: 0,
            cycleSeconds: 0,
            damages,
            range: readRangeInfo(module, effect, cls.kind),
            chargeTypeID: module.charge?.typeID,
            count: 1,
        }
    }

    const cycle = readCycleInfo(module, cls.kind)
    if (cycle.cycleSeconds <= 0) {
        // Defensive fallback for modules with no rate-of-fire — should be
        // rare. Treat as 0 DPS rather than divide by zero.
        return {
            sourceID: module.id,
            typeID: module.typeID,
            kind: cls.kind,
            alpha: damages.total * cycle.damageMultiplier,
            dps: 0,
            cycleSeconds: 0,
            damages,
            range: readRangeInfo(module, effect, cls.kind),
            chargeTypeID: module.charge?.typeID,
            count: 1,
        }
    }

    const alpha = damages.total * cycle.damageMultiplier
    const dps = alpha / cycle.cycleSeconds
    const reloadInfo = readReloadInfo(module)
    const sustainedDps = computeSustainedDps(
        alpha, cycle.cycleSeconds, reloadInfo.reloadSeconds, reloadInfo.chargesPerLoad,
    )
    // Vorton chain-lightning DPS — applies to two effect families:
    //   - 8037 `ChainLightning` (ship-side Small/Medium/Large Vorton
    //     Projector): targets attr 3037, reduction attr 1353
    //     `aoeDamageReductionFactor` (loss-per-hop fraction).
    //   - 6447 `lightningWeapon` (Standup Arcing Vorton Projector,
    //     XL structure weapon): targets attr 2104
    //     `lightningWeaponTargetAmount`, reduction attr 2106 (no SDE name
    //     exposed, treated as loss-per-hop by the same convention as 1353
    //     pending Pyfa source verification — values sit in the same
    //     0..1 range so the formula degenerates safely).
    //
    // Geometric series: total = dps × Σ_{k=0..N-1} (1 - reduction)^k.
    const VORTON_CHAIN_SPECS: Array<{ effectID: number; targetsAttr: number; reductionAttr: number }> = [
        { effectID: 8037, targetsAttr: 3037, reductionAttr: 1353 },
        { effectID: 6447, targetsAttr: 2104, reductionAttr: 2106 },
    ]
    let chainDpsMax: number | undefined
    let chainTargetCount: number | undefined
    for (const spec of VORTON_CHAIN_SPECS) {
        if (!module.effectIDs.has(spec.effectID)) continue
        const targets = Math.max(1, Math.round(module.getFinal(spec.targetsAttr, 1)))
        const reductionFactor = module.getFinal(spec.reductionAttr, 0)
        if (reductionFactor > 0 && reductionFactor < 1) {
            const r = 1 - reductionFactor
            const multiplier = (1 - Math.pow(r, targets)) / (1 - r)
            chainDpsMax = dps * multiplier
        } else {
            chainDpsMax = dps * targets
        }
        chainTargetCount = targets
        break
    }
    // Triglavian disintegrator metadata for the spool slider UI. The two
    // attrs come from the module's typeDogma (2733 per-cycle, 2734 max
    // bonus); we read getFinal so ship-hull boosts (e.g. Babaroga effect
    // 12288 → +20 %/level Large Precursor Weapon on attr 2734) propagate.
    //
    // `baseDps` is the spool=0 DPS for this row, derived from the just-
    // computed `dps` and the engine's current spool fraction
    // (`ctx.disintegratorSpoolPercent`). Doing this here — using the
    // SAME spool the engine actually applied — means the UI can render
    // a stable Min DPS (= baseDps) and Max DPS (= baseDps × (1 +
    // maxBonus)) regardless of where the slider currently sits, instead
    // of the UI reverse-engineering the values from a possibly-stale
    // `disintegratorSpoolPct` while the debounced recompute is in
    // flight (which produced a visible drift mid-drag).
    let disintegrator: { maxBonus: number; bonusPerCycle: number; baseDps: number } | undefined
    if (module.effectIDs.has(6995 /* targetDisintegratorAttack */)) {
        const maxBonus = module.hasAttr(2734) ? module.getFinal(2734, 0) : 0
        const bonusPerCycle = module.hasAttr(2733) ? module.getFinal(2733, 0) : 0
        if (maxBonus > 0) {
            const spoolFactor = 1 + ctx.disintegratorSpoolPercent * maxBonus
            const baseDps = spoolFactor > 0 ? dps / spoolFactor : dps
            disintegrator = { maxBonus, bonusPerCycle, baseDps }
        }
    }
    return {
        sourceID: module.id,
        typeID: module.typeID,
        kind: cls.kind,
        alpha,
        dps,
        sustainedDps,
        reloadSeconds: reloadInfo.reloadSeconds || undefined,
        chargesPerLoad: reloadInfo.chargesPerLoad,
        chainDpsMax,
        chainTargetCount,
        cycleSeconds: cycle.cycleSeconds,
        damages: scaledDamage(damages, cycle.damageMultiplier),
        range: readRangeInfo(module, effect, cls.kind),
        chargeTypeID: module.charge?.typeID,
        count: 1,
        disintegrator,
    }
}

/** Effect ID that flags a charge as a Breacher Pod (DOT weapon). Empty
 *  modifierInfo in the SDE — Pyfa hardcodes the damage formula. */
const BREACHER_POD_EFFECT_ID = 12174

/** Default target HP used when computing breacher pod sustained damage.
 *  Pyfa added a per-target-profile `total HP` field in v2.61.0 that
 *  controls when the cap binds; we pick a value large enough that the cap
 *  always binds for typical target profiles (cap = 600 GJ × 1.25 with
 *  Clone Efficacity V = 750; binding at HP ≥ 75 k under default 1 % per
 *  tick at All-V). 100k matches Pyfa's stock display behaviour. */
const BREACHER_POD_DEFAULT_TARGET_HP = 100_000

function breacherContributionFor(
    module: ItemState,
    cycleSeconds: number,
    effect: SdeEffect,
    cls: ReturnType<typeof classifyWeapon> & {},
): WeaponContribution {
    const charge = module.charge!
    const maxPerTick = charge.getFinal(ATTR.DOT_MAX_DAMAGE_PER_TICK, 0)
    const pctPerTickRaw = charge.getFinal(ATTR.DOT_MAX_HP_PERCENTAGE_PER_TICK, 0)
    const dotDurationMs = charge.getFinal(ATTR.DOT_DURATION, 0)
    // Per-tick cap formula. dotMaxHPPercentagePerTick is stored as a
    // percent (e.g. 0.8 → 0.8 %), so divide by 100 before multiplying HP.
    const pctDamage = (pctPerTickRaw / 100) * BREACHER_POD_DEFAULT_TARGET_HP
    const tickDamage = Math.min(maxPerTick, pctDamage)
    // Pyfa-parity: each launcher fires one breacher per launcher cycle,
    // and the DOT runs at 1 tick / second for `dotDuration / 1000` ticks.
    // Sustained DPS = the per-tick value once a pod is attached (overlap
    // of multiple pods isn't modelled here — Pyfa's headline DPS column
    // also shows the single-pod tick value, not the launcher × overlap
    // sum). Volley = single-tick alpha — matches Pyfa's volley column
    // which shows damage in a 1-second snapshot.
    const damages = {
        em: 0,
        thermal: tickDamage,  // SCARAB Breacher Pod → thermal flavour
        kinetic: 0,
        explosive: 0,
        total: tickDamage,
    }
    return {
        sourceID: module.id,
        typeID: module.typeID,
        kind: cls.kind,
        alpha: tickDamage,
        dps: tickDamage,
        cycleSeconds: cycleSeconds || (dotDurationMs > 0 ? dotDurationMs / 1000 : 1),
        damages,
        range: readRangeInfo(module, effect, cls.kind),
        chargeTypeID: charge.typeID,
        count: 1,
    }
}

function droneContributionFor(
    drone: ItemState,
    countActive: number,
    _ctx: FitContext,
    dataset: FittingDataset,
): WeaponContribution | null {
    // Drones use the same weapon classification as modules — they declare
    // a targetAttack / projectileFired / useMissiles effect which gives us
    // the cycle + range. Damage components live on the drone itself (the
    // drone IS the damage source), there's no "loaded charge" pairing.
    const cls = classifyWeapon(drone)
    if (!cls) return null
    const effect = dataset.effects.get(cls.effectID)
    if (!effect) return null

    // Read damage from the drone (cls.damageSource will be the drone since
    // it's not turret/missile typed, but for safety we read from the drone
    // directly — many drones DO classify as TURRET/MISSILE because of the
    // effect they share with launchers).
    const damages = readDamageComponentsFromDrone(drone)
    if (damages.total <= 0) return null

    const cycleMs = drone.getFinal(ATTR.RATE_OF_FIRE, 0)
        || drone.getFinal(ATTR.DAMAGE_DURATION, 0)
    if (cycleMs <= 0) return null
    const cycleSeconds = cycleMs / 1000
    const damageMultiplier = drone.getFinal(ATTR.DAMAGE_MULTIPLIER, 1)
    const alphaSingle = damages.total * damageMultiplier
    const dpsSingle = alphaSingle / cycleSeconds

    return {
        sourceID: drone.id,
        typeID: drone.typeID,
        kind: 'DRONE',
        alpha: alphaSingle * countActive,
        dps: dpsSingle * countActive,
        cycleSeconds,
        damages: scaledDamage(damages, damageMultiplier * countActive),
        range: readRangeInfo(drone, effect, cls.kind),
        count: countActive,
    }
}

// Drones store their damage on the drone itself (they're their own
// "damage source"). This helper reads the four components without going
// through the charge fallback in readDamageComponents.
function readDamageComponentsFromDrone(drone: ItemState): WeaponDamageComponents {
    const em = drone.getFinal(ATTR.EM_DAMAGE, 0)
    const thermal = drone.getFinal(ATTR.THERMAL_DAMAGE, 0)
    const kinetic = drone.getFinal(ATTR.KINETIC_DAMAGE, 0)
    const explosive = drone.getFinal(ATTR.EXPLOSIVE_DAMAGE, 0)
    return { em, thermal, kinetic, explosive, total: em + thermal + kinetic + explosive }
}

function scaledDamage(d: WeaponDamageComponents, factor: number): WeaponDamageComponents {
    return {
        em: d.em * factor,
        thermal: d.thermal * factor,
        kinetic: d.kinetic * factor,
        explosive: d.explosive * factor,
        total: d.total * factor,
    }
}
