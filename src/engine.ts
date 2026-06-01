/**
 * Top-level fit calculation orchestrator.
 *
 * `computeFit(fit, dataset, options)` builds the runtime ItemState graph,
 * applies the canonical EVE modifier pipeline in order, and returns a
 * ComputedFit suitable for UI rendering.
 *
 * Phase 1 scope (this file as of the foundation cut):
 *   - Build ItemState graph from the persistent Fit + dataset
 *   - Apply skills via the modifier engine (LocationRequiredSkillModifier
 *     family) — full coverage for ~93% of skill-based bonuses
 *   - Apply ship intrinsic effects (LocationModifier on the ship type's
 *     own effects)
 *   - Apply module effects filtered by current state (offline excluded)
 *   - Apply implants / boosters / mode / subsystems via the same dispatcher
 *   - Snapshot a minimal DerivedStats (ship hp/cap/nav/targeting + slot
 *     usage). Advanced derived stats (DPS / cap stability / EHP against
 *     damage profile / projected EWAR) are STUBBED — they live in
 *     dedicated modules under `derived/` and `effects/` that the next
 *     phases will fill in.
 *
 * Out of scope (Phase 2+):
 *   - Capacitor stability simulation (cap drain vs recharge curve)
 *   - Weapon DPS calc (turret tracking + missile DRF)
 *   - Drone DPS aggregation
 *   - Damage-profile-aware EHP (requires a target damage distribution)
 *   - Projected EWAR / fleet command bursts
 *   - Mutaplasmid attribute application (handled at ItemState construction
 *     via attributeOverrides, but the UI sliders aren't wired yet)
 *
 * The returned `derived` block is intentionally partial in this phase;
 * downstream code MUST treat it as best-effort and not assume DPS/cap
 * fields are populated until Phase 2/3.
 */

import { ATTR } from './constants'
import { FitContext } from './fitContext'
import {
    ItemState,
    makeBoosterState,
    makeCharacterState,
    makeDroneState,
    makeFighterState,
    makeImplantState,
    makeModeState,
    makeModuleState,
    makeShipState,
    makeSubsystemState,
} from './itemState'
import {
    applyLegacyBastion,
    applyLegacyCapBoosterInjection,
    applyLegacyCapitalEhe,
    applyLegacyCommandBursts,
    applyLegacyDoomsdaySelfEffects,
    applyLegacyEntosisLink,
    applyLegacyFighterAbilities,
    applyLegacyHicBubble,
    applyLegacyMjdSigBloom,
    applyLegacyDisintegratorSpool,
    applyLegacyMutadaptiveSpool,
    applyLegacyOverload,
    applyLegacyProjectionEwar,
    applyLegacyPropMods,
    applyLegacyRAH,
    applyLegacySubsystemAddPassive,
    applyLegacySubsystemSlots,
    applyLegacySystemEffect,
    applyLegacyFighterProjection,
    applySkills,
    applySourceItem,
    buildCapWarfareReport,
    buildEcmProjectionReport,
    buildRemoteRepReport,
    collectEffectStoppers,
} from './modifierEngine'
import { computeLayerEhp, computeTotalEhp } from './derived/ehp'
import { computeCapacitor } from './derived/capacitor'
import { computeTank } from './derived/tank'
import { computeOffense } from './derived/offense'
import { computeStructureMeta } from './derived/structure'
import type {
    ComputedAttribute,
    ComputedFit,
    DamageProfile,
    DerivedStats,
    Fit,
    FittingDataset,
    ProjectedEffectReport,
    ProjectedSource,
    SkillProfile,
    SlotType,
    TargetProfile,
} from './types'
import { classifyEwar, combineJamChances, ecmJamChance } from './effects/ewar'

// Built-in synthetic character type used as the modifier target for skill
// effects. Real EVE has no such type — Pyfa synthesises one too. Carries no
// dogma attributes; skills LIVE on the character through the skillLevels
// map, not through real attributes here.
const SYNTHETIC_CHARACTER_TYPE = {
    id: -1,
    name: 'Character',
    groupID: -1,
    categoryID: -1,
    attributes: [],
    effects: [],
} as const

export interface ComputeFitOptions {
    /** Skill levels keyed by skill type id. Missing skills default to 0. */
    skillProfile: SkillProfile
    /** Damage profile for EHP-vs-profile computation. Omitted → omni 25%. */
    damageProfile?: DamageProfile | null
    /** Target profile for stats-vs-target (effective DPS at range,
     *  application drop-off vs sig/speed). Stored on the engine output
     *  for downstream consumers; the offense aggregator reads it
     *  directly from there. */
    targetProfile?: TargetProfile | null
    /** Hostile sources projecting onto this fit. Their effects apply with
     *  `domain: 'targetID'` resolved to the fit's own ship. */
    projected?: ProjectedSource[]
    /** Skill levels assumed for the projected attacker. Defaults to All V
     *  (matches how Pyfa renders projected effects "fed by All V skills"). */
    projectedSkillLevels?: Map<number, number>
    /** Mutadaptive Remote Armor Repairer spool fraction (0..1). 1.0 =
     *  fully spooled (max bonus); 0 = unspooled (no bonus). Defaults to 1
     *  if omitted, matching Pyfa's "always-spooled" sustained engagement
     *  assumption. */
    spoolPercent?: number
    /** Triglavian Entropic Disintegrator spool fraction (0..1). Same
     *  semantics as `spoolPercent` but applied to disintegrator weapons'
     *  damageMultiplier (effect 6995, attrs 2733/2734). Defaults to 1
     *  (full spool) for parity with Pyfa's default DPS column. */
    disintegratorSpoolPercent?: number
    /** System effect beacon typeID (Incursion/Triglavian/Drifter/Wormhole).
     *  When set, the engine reads the beacon's attrs from the dataset and
     *  applies the corresponding system-wide debuff/buff. */
    systemEffectTypeID?: number | null
}

export function computeFit(
    fit: Fit,
    dataset: FittingDataset,
    opts: ComputeFitOptions,
): ComputedFit {
    // ---------- Phase 1: build ItemState graph ----------
    const shipType = dataset.getType(fit.shipTypeID)
    if (!shipType) {
        throw new Error(`computeFit: unknown ship typeID ${fit.shipTypeID}`)
    }
    const ship = makeShipState(shipType)
    const character = makeCharacterState(SYNTHETIC_CHARACTER_TYPE as any)

    const modules = fit.modules.flatMap(fm => {
        const t = dataset.getType(fm.typeID)
        if (!t) return []
        const charge = fm.chargeTypeID ? dataset.getType(fm.chargeTypeID) : undefined
        return [makeModuleState(fm, t, charge)]
    })

    const drones = fit.drones.flatMap(fd => {
        const t = dataset.getType(fd.typeID)
        return t ? [makeDroneState(fd, t)] : []
    })
    const fighters = fit.fighters.flatMap(ff => {
        const t = dataset.getType(ff.typeID)
        return t ? [makeFighterState(ff, t)] : []
    })
    const implants = fit.implants.flatMap(fi => {
        const t = dataset.getType(fi.typeID)
        return t ? [makeImplantState(fi, t)] : []
    })
    const boosters = fit.boosters.flatMap(fb => {
        const t = dataset.getType(fb.typeID)
        return t ? [makeBoosterState(fb, t)] : []
    })
    const subsystems = fit.subsystems.flatMap(fs => {
        const t = dataset.getType(fs.typeID)
        return t ? [makeSubsystemState(fs, t)] : []
    })
    let mode
    if (fit.modeTypeID !== undefined) {
        const t = dataset.getType(fit.modeTypeID)
        if (t) mode = makeModeState(fit.modeTypeID, t)
    }

    // ---------- Phase 2: build FitContext ----------
    const skillLevels = new Map<number, number>()
    for (const [k, v] of Object.entries(opts.skillProfile.skills)) {
        skillLevels.set(Number(k), v)
    }

    const ctx = new FitContext({
        ship,
        character,
        skillLevels,
        modules,
        drones,
        fighters,
        implants,
        boosters,
        subsystems,
        mode,
        skillProfile: opts.skillProfile,
        dataset,
        disintegratorSpoolPercent: opts.disintegratorSpoolPercent ?? 1,
    })

    // ---------- Phase 3: apply effects ----------
    // Order matters: skills before ship before subsystems before modules
    // before drones/fighters before implants/boosters/mode. Each phase
    // commits its modifications; later phases see the partially-modified
    // state when reading source attribute values (intentional — implants
    // boosting CPU should boost a CPU value already augmented by skills).
    applySkills(ctx, dataset)
    applySourceItem(ship, ctx, dataset)
    for (const s of subsystems) applySourceItem(s, ctx, dataset)
    // T3C subsystems grant high/med/low slot counts and turret/launcher
    // hardpoints via plain attributes (NOT modifierInfo), so the generic
    // dispatcher above misses them. Without this, T3C ships report 0
    // hi/med/lo and the editor renders no module slots at all.
    applyLegacySubsystemSlots(ctx)
    applyLegacySubsystemAddPassive(ctx)

    // Pyfa-parity: hostile projected scram/disruptor stops MWD (effect
    // 6441) / MJD (effect 6442) on the target. Pre-build the typed
    // ProjectedSource list as ItemState the same way the projection pass
    // does later, then walk for `func: EffectStopper` modifierInfo. The
    // resulting Set is read inside `applySourceItem` to skip ship-mounted
    // modules' suppressed effect IDs. Two-pass here so local modules
    // apply with the right stoppers before propmods compute thrust.
    if (opts.projected && opts.projected.length > 0) {
        const earlyProjected: ItemState[] = []
        for (const ps of opts.projected) {
            const t = dataset.getType(ps.typeID)
            if (!t) continue
            const chargeType = ps.chargeTypeID ? dataset.getType(ps.chargeTypeID) : undefined
            earlyProjected.push(makeModuleState({
                id: ps.id,
                typeID: ps.typeID,
                slotType: 'HI',
                position: 0,
                state: ps.state,
                chargeTypeID: ps.chargeTypeID,
                mutator: ps.mutator,
            }, t, chargeType))
        }
        ctx.stoppedLocalEffectIDs = collectEffectStoppers(earlyProjected, dataset)
    }

    // Charges BEFORE modules: a loaded charge carries effects that modify
    // its PARENT MODULE via domain='otherID' (sensor-booster / tracking-
    // computer scripts that double one bonus and zero another; faction
    // crystal range/falloff/damage shifts). The module's own outgoing
    // (module→ship) modifiers read those bonus attributes when computing
    // their value EAGERLY, so the charge's modification must already be on
    // the module before the module is processed — otherwise a Scan
    // Resolution Script's "× scanResolutionBonus, zero maxTargetRangeBonus"
    // lands too late and the ship sees the unscripted bonus. Charge value
    // reads only touch charge-side attributes (modifyingAttributeID lives on
    // the charge), so this ordering is safe for the charge's own modifiers.
    for (const m of modules) if (m.charge) applySourceItem(m.charge, ctx, dataset)
    for (const m of modules) applySourceItem(m, ctx, dataset)
    for (const d of drones) applySourceItem(d, ctx, dataset)
    for (const f of fighters) applySourceItem(f, ctx, dataset)
    for (const i of implants) applySourceItem(i, ctx, dataset)
    for (const b of boosters) applySourceItem(b, ctx, dataset)
    if (mode) applySourceItem(mode, ctx, dataset)

    // Overheat first so the propmod handler (which reads
    // `speedFactor` from each MWD/AB) sees the OVERLOAD bonus already
    // baked in. Without this ordering, an overheated MWD's speed boost
    // would still be calculated against the unheated speedFactor.
    applyLegacyOverload(ctx)

    // Legacy AB/MWD propulsion bonus — runs AFTER all skills/modules
    // because the formula uses the FULLY-MODIFIED module thrust + ship
    // mass. Effects 6730/6731 are pre-expression in the SDE so the
    // generic dispatcher can't handle them.
    applyLegacyPropMods(ctx)

    // Other Pyfa-parity legacy handlers — each covers one effect family
    // whose `modifierInfo` is empty in the SDE. Order matters where
    // there's a dependency on prior pipeline output: Entosis sets
    // disallowAssistance which downstream handlers may need to read;
    // Cap Booster injection rewrites a module's capacitorNeed and must
    // run before the cap derive step. HIC bubble nerfs propulsion
    // modules and so should run BEFORE applyLegacyPropMods would
    // re-read them — we accept a one-tick lag here (the cycle would
    // need to be re-run for full convergence, but a single pass is
    // accurate to within ~1% for typical fits).
    applyLegacyEntosisLink(ctx)
    applyLegacyCapitalEhe(ctx)
    applyLegacyHicBubble(ctx)
    applyLegacyMjdSigBloom(ctx)
    applyLegacyCommandBursts(ctx)
    applyLegacyCapBoosterInjection(ctx)
    applyLegacyDoomsdaySelfEffects(ctx)
    applyLegacyBastion(ctx)
    applyLegacyMutadaptiveSpool(ctx, opts.spoolPercent ?? 1)
    applyLegacyDisintegratorSpool(ctx, opts.disintegratorSpoolPercent ?? 1)
    applyLegacyFighterAbilities(ctx)
    applyLegacySystemEffect(ctx, opts.systemEffectTypeID ?? null)
    // RAH adaptation runs LAST (Pyfa uses runtime='late' for this) so its
    // damage-weighted resonance read sees the fully-modified ship state
    // (post-skills, post-modules, post-membranes). Without a damage
    // profile, the RAH stays at its base resonances and contributes
    // nothing — the caller must pass a profile for adaptation to occur.
    applyLegacyRAH(ctx, opts.damageProfile ?? null)

    // ---------- Projection pass ----------
    // Hostile modules apply their effects with `domain: targetID` redirecting
    // to the fit's own ship. We swap ctx.target to the ship for the duration
    // of the projection pass and restore after — this lets the unmodified
    // generic modifier engine handle EWAR mechanics that have modifierInfo
    // (sensor damp / tracking disrupt / web). ECM is stochastic and is
    // reported separately in `derived.projected[]`.
    //
    // Per-source gates:
    //   - If `disallowOffensiveModifiers` (attr 872) is set on the ship
    //     (e.g. Bastion Mode active), HOSTILE projections are skipped.
    //   - Friendly buff projections (Remote Sensor Booster effect 6427 +
    //     Remote Tracking Computer 6428) bypass that gate but are gated
    //     by `disallowAssistance` instead — applied per-handler.
    const projectionReports: ProjectedEffectReport[] = []
    const offensiveModifiersDisallowed = ctx.ship.getFinal(872, 0) > 0
    const FRIENDLY_PROJECTION_EFFECT_IDS = new Set([6427, 6428])
    if (opts.projected && opts.projected.length > 0) {
        const previousTarget = ctx.target
        ctx.target = ctx.ship
        for (const ps of opts.projected) {
            const t = dataset.getType(ps.typeID)
            if (!t) continue
            const chargeType = ps.chargeTypeID ? dataset.getType(ps.chargeTypeID) : undefined
            const projectedItem = makeModuleState({
                id: ps.id,
                typeID: ps.typeID,
                slotType: 'HI',
                position: 0,
                state: ps.state,
                chargeTypeID: ps.chargeTypeID,
                mutator: ps.mutator,
            }, t, chargeType)
            ctx.projectedSources.push(projectedItem)

            // Apply only when the projection is ACTIVE (or OVERLOAD) — an
            // ECM module sitting offline doesn't jam anything.
            if (projectedItem.state === 'ACTIVE' || projectedItem.state === 'OVERLOAD') {
                // Friendly-vs-hostile detection — friendly RSB/RTC bypass
                // the disallowOffensiveModifiers gate but get gated by
                // disallowAssistance inside their own handlers.
                let isFriendly = false
                for (const eid of FRIENDLY_PROJECTION_EFFECT_IDS) {
                    if (projectedItem.effectIDs.has(eid)) { isFriendly = true; break }
                }
                if (!isFriendly && offensiveModifiersDisallowed) {
                    // Skip hostile data-driven AND legacy dispatch entirely.
                    continue
                }
                applySourceItem(projectedItem, ctx, dataset)
                if (projectedItem.charge) applySourceItem(projectedItem.charge, ctx, dataset)
                // Legacy projection-falloff EWAR (web/damp/paint/track/
                // guidance) — empty modifierInfo in the SDE so the
                // generic dispatch above won't catch them. Reads
                // `projectionRange` off the source so range falloff
                // attenuates the magnitude.
                applyLegacyProjectionEwar(projectedItem, ps.projectionRange, ctx)

                // Fighter projection abilities (web / cap-neut). Empty
                // modifierInfo on each fighter ability effect; Pyfa
                // hardcodes them. Scram/tackle are handled separately
                // via collectEffectStoppers in the pre-pass above.
                for (const fighterReport of applyLegacyFighterProjection(projectedItem, ctx)) {
                    projectionReports.push(fighterReport)
                }

                // Remote-rep / cap-warfare / ECM projections don't write
                // afflictions — they emit per-second metrics into the
                // ProjectedEffectReport surface so the UI can render
                // "incoming reps" / "incoming drain" / "jam chance".
                const repReport = buildRemoteRepReport(projectedItem, ps.projectionRange, ctx)
                if (repReport) {
                    const kind = repReport.layer === 'SHIELD' ? 'REMOTE_REP_SHIELD' as const
                        : repReport.layer === 'ARMOR'  ? 'REMOTE_REP_ARMOR'  as const
                        : 'REMOTE_REP_HULL' as const
                    projectionReports.push({
                        typeID: projectedItem.typeID,
                        kind,
                        perSecond: repReport.perSecond,
                        summary: `${repReport.layer} rep incoming: ${repReport.perSecond.toFixed(1)} HP/s`,
                    })
                    continue
                }
                const capReport = buildCapWarfareReport(projectedItem, ps.projectionRange, ctx)
                if (capReport) {
                    const sign = capReport.perSecond >= 0 ? 'drain' : 'injection'
                    projectionReports.push({
                        typeID: projectedItem.typeID,
                        kind: capReport.kind,
                        perSecond: capReport.perSecond,
                        summary: `Cap ${sign}: ${Math.abs(capReport.perSecond).toFixed(1)} GJ/s`,
                    })
                    continue
                }
                const ecmReport = buildEcmProjectionReport(projectedItem, ps.projectionRange, ctx)
                if (ecmReport) {
                    projectionReports.push({
                        typeID: projectedItem.typeID,
                        kind: 'ECM',
                        jamChance: ecmReport.jamChance,
                        summary: `Per-cycle jam chance ${(ecmReport.jamChance * 100).toFixed(1)}%`,
                    })
                    continue
                }
                projectionReports.push(buildProjectionReport(projectedItem, ctx))
            }
        }
        ctx.target = previousTarget
    }

    // ---------- Phase 4: derive stats ----------
    return {
        fit,
        ship: snapshotMap(ship),
        modules: new Map(modules.map(m => [m.id, {
            fitModuleID: m.id,
            typeID: m.typeID,
            slotType: (m.slotType() ?? 'LO') as SlotType,
            state: m.state,
            attributes: snapshotMap(m),
            effectiveCpu: m.getFinal(ATTR.CPU_USED, 0),
            effectivePower: m.getFinal(ATTR.POWER_USED, 0),
        }])),
        drones: new Map(drones.map(d => [d.id, {
            fitDroneID: d.id,
            typeID: d.typeID,
            attributes: snapshotMap(d),
            dps: 0,  // Phase 3
        }])),
        fighters: new Map(fighters.map(f => [f.id, {
            fitFighterID: f.id,
            typeID: f.typeID,
            attributes: snapshotMap(f),
            abilities: [],  // Phase 3
        }])),
        derived: deriveStats(ctx, dataset, opts.damageProfile ?? null, fit, projectionReports),
    }
}

function snapshotMap(item: ReturnType<typeof makeShipState>): Map<number, ComputedAttribute> {
    const map = new Map<number, ComputedAttribute>()
    for (const [id, ma] of item.attributesEntries()) {
        const final = ma.compute()
        map.set(id, {
            id,
            base: ma.base,
            final,
            afflictions: ma.afflictions,
        })
    }
    return map
}

/**
 * Derive the full DerivedStats block. Defense (EHP-vs-profile), capacitor
 * (peak rate + stable %) and tank (active reps + passive regen) are
 * populated from the dedicated derive modules. Offense, drones bay usage,
 * and projected EWAR are still placeholder zeros — Phase 3+.
 */
/**
 * Summarise a single projected EWAR module into a one-row UI report.
 * Deterministic effects (sensor damp / tracking disrupt / web / scram) are
 * already baked into the modified attributes by the modifier engine; the
 * report is purely descriptive. ECM is stochastic — we compute the per-cycle
 * jam chance against the ship's sensor strength and surface it.
 */
function buildProjectionReport(source: ItemState, ctx: FitContext): ProjectedEffectReport {
    const cls = classifyEwar(source)
    if (!cls) {
        return { typeID: source.typeID, kind: 'OTHER', summary: `${source.kind} module projected` }
    }
    if (cls.kind === 'ECM') {
        const chance = ecmJamChance(source, ctx.ship)
        return {
            typeID: source.typeID,
            kind: 'ECM',
            jamChance: chance,
            summary: `Per-cycle jam chance ${(chance * 100).toFixed(1)}%`,
        }
    }
    const labels: Record<string, string> = {
        SENSOR_DAMP: 'Sensor strength / lock range reduced',
        TRACKING_DISRUPT: 'Turret tracking / range reduced',
        WEB: 'Max velocity reduced',
        WARP_SCRAM: 'Warp ability disabled',
        WARP_DISRUPT: 'Warp disrupted (point)',
        NEUT: 'Capacitor drain incoming',
        NOS: 'Capacitor siphoned',
    }
    return {
        typeID: source.typeID,
        kind: cls.kind,
        summary: labels[cls.kind] ?? cls.kind,
    }
}

function deriveStats(
    ctx: FitContext,
    dataset: FittingDataset,
    damageProfile: DamageProfile | null,
    fit: Fit,
    projectionReports: ProjectedEffectReport[],
): DerivedStats {
    const ship = ctx.ship

    const slotUsed: Record<SlotType, number> = { HI: 0, MED: 0, LO: 0, RIG: 0, SUBSYSTEM: 0, SERVICE: 0 }
    let cpuUsed = 0
    let powerUsed = 0
    let calibUsed = 0
    let turretHardpointsUsed = 0
    let launcherHardpointsUsed = 0

    // Effect IDs that consume a turret / launcher hardpoint. Mirrors the
    // WEAPON_EFFECT_KIND['TURRET' | 'MISSILE'] entries — kept inline as a
    // small Set to avoid pulling fitChecks.ts into the engine import
    // graph (and to skip a property lookup per effect).
    const TURRET_EFFECTS:   ReadonlySet<number> = new Set([10, 34, 6995, 8037])
    const LAUNCHER_EFFECTS: ReadonlySet<number> = new Set([9, 101])

    for (const m of ctx.modules) {
        if (m.state === 'OFFLINE') continue  // offline modules don't count for fitting
        const slot = m.slotType()
        if (slot) slotUsed[slot]++
        cpuUsed += m.getFinal(ATTR.CPU_USED, 0)
        powerUsed += m.getFinal(ATTR.POWER_USED, 0)
        if (slot === 'RIG') calibUsed += m.getFinal(ATTR.UPGRADE_COST, 0)
        // Hardpoint accounting (HI modules only, but checking effect IDs
        // is cheaper than testing slot first since the sets are tiny).
        for (const eid of m.effectIDs) {
            if (TURRET_EFFECTS.has(eid))   { turretHardpointsUsed   += 1; break }
            if (LAUNCHER_EFFECTS.has(eid)) { launcherHardpointsUsed += 1; break }
        }
    }

    // Drone bay / bandwidth usage. Drone packaged volume isn't a dogma
    // attribute — it's the type's `volume` field on the SDE row. The Fit's
    // FitDrone records carry the per-group counts (total in bay vs active
    // out flying); bay accounts the full count, bandwidth only the active.
    let droneBayUsed = 0
    let droneBwUsed = 0
    const fitDronesById = new Map(fit.drones.map(d => [d.id, d]))
    for (const droneItem of ctx.drones) {
        const fd = fitDronesById.get(droneItem.id)
        if (!fd) continue
        const t = dataset.getType(droneItem.typeID)
        if (!t) continue
        const volume = t.volume ?? 0
        const bandwidth = droneItem.getBase(ATTR.DRONE_BANDWIDTH) ?? 0
        droneBayUsed += volume * fd.countTotal
        droneBwUsed += bandwidth * fd.countActive
    }

    const shieldEhp = computeLayerEhp(ship, 'SHIELD', damageProfile)
    const armorEhp  = computeLayerEhp(ship, 'ARMOR',  damageProfile)
    const hullEhp   = computeLayerEhp(ship, 'HULL',   damageProfile)

    const cap = computeCapacitor(ctx, dataset)
    const tank = computeTank(ctx)
    const offense = computeOffense(ctx, dataset, fit)

    return {
        fitting: {
            cpuUsed,
            cpuMax: ship.getFinal(ATTR.CPU_OUTPUT, 0),
            powerUsed,
            powerMax: ship.getFinal(ATTR.POWER_OUTPUT, 0),
            calibrationUsed: calibUsed,
            calibrationMax: ship.getFinal(ATTR.UPGRADE_CAPACITY, 0),
            droneBandwidthUsed: droneBwUsed,
            droneBandwidthMax: ship.getFinal(ATTR.DRONE_BANDWIDTH, 0),
            droneBayUsed,
            droneBayMax: ship.getFinal(ATTR.DRONE_CAPACITY, 0),
            slots: {
                HI: { used: slotUsed.HI, max: ship.getFinal(ATTR.HI_SLOTS, 0) },
                MED: { used: slotUsed.MED, max: ship.getFinal(ATTR.MED_SLOTS, 0) },
                LO: { used: slotUsed.LO, max: ship.getFinal(ATTR.LOW_SLOTS, 0) },
                RIG: { used: slotUsed.RIG, max: ship.getFinal(ATTR.RIG_SLOTS, 0) },
                SUBSYSTEM: { used: slotUsed.SUBSYSTEM, max: ship.getFinal(ATTR.SUBSYSTEM_SLOTS, 0) },
                SERVICE: { used: slotUsed.SERVICE, max: ship.getFinal(ATTR.SERVICE_SLOTS, 0) },
            },
            hardpoints: {
                turret:   { used: turretHardpointsUsed,   max: ship.getFinal(ATTR.TURRET_HARDPOINTS, 0)   },
                launcher: { used: launcherHardpointsUsed, max: ship.getFinal(ATTR.LAUNCHER_HARDPOINTS, 0) },
            },
        },
        defense: {
            shield: shieldEhp,
            armor: armorEhp,
            hull: hullEhp,
            ehpTotalAgainstProfile: computeTotalEhp(shieldEhp, armorEhp, hullEhp, damageProfile != null),
        },
        offense: {
            weaponDps: offense.weaponDps,
            weaponSustainedDps: offense.weaponSustainedDps,
            droneDps: offense.droneDps,
            fighterDps: offense.fighterDps,
            totalDps: offense.totalDps,
            totalSustainedDps: offense.totalSustainedDps,
            alphaStrike: offense.alphaStrike,
            weaponOptimal: offense.weaponOptimal,
            weaponFalloff: offense.weaponFalloff,
            weaponTracking: offense.weaponTracking,
            explosionVelocity: offense.explosionVelocity,
            explosionRadius: offense.explosionRadius,
            breakdown: offense.breakdown,
        },
        capacitor: {
            capacity: cap.capacity,
            rechargeMs: cap.rechargeMs,
            peakRechargeRate: cap.peakRechargeRate,
            usagePerSecond: cap.usagePerSecond,
            stable: cap.stable,
            stablePercent: cap.stablePercent,
            secondsToEmpty: cap.secondsToEmpty,
        },
        tank,
        navigation: {
            maxVelocity: ship.getFinal(ATTR.MAX_VELOCITY, 0),
            mass: ship.getFinal(ATTR.MASS, 0),
            agility: ship.getFinal(ATTR.AGILITY, 0),
            alignTimeSeconds: computeAlignTime(ship),
            warpSpeed: ship.getFinal(ATTR.WARP_SPEED_MULTIPLIER, 1),
        },
        targeting: {
            // Apply SDE `maxAttributeID=797` (maximumRangeCap, default 300 km)
            // clamp to attr 76. Pyfa-parity: Avatar (base 250 km) with
            // Long Range Targeting V (+25 %) computes 312.5 km but is
            // clamped to 300 km by the cap; Sensor Arrays / Sensor Boosters
            // raise the cap via PreAssign on attr 797 to lift the clamp.
            maxTargetingRange: Math.min(
                ship.getFinal(ATTR.MAX_TARGET_RANGE, 0),
                ship.getFinal(ATTR.MAX_TARGET_RANGE_CAP, 300_000),
            ),
            maxLockedTargets: ship.getFinal(ATTR.MAX_LOCKED_TARGETS, 0),
            signatureRadius: ship.getFinal(ATTR.SIGNATURE_RADIUS, 0),
            scanResolution: ship.getFinal(ATTR.SCAN_RESOLUTION, 0),
            sensorStrength: pickSensorStrength(ship).value,
            sensorType: pickSensorStrength(ship).type,
        },
        drones: {
            bayUsed: droneBayUsed,
            bayMax: ship.getFinal(ATTR.DRONE_CAPACITY, 0),
            bandwidthUsed: droneBwUsed,
            bandwidthMax: ship.getFinal(ATTR.DRONE_BANDWIDTH, 0),
            active: ctx.drones.filter(d => d.state === 'ACTIVE').length,
            // Drone control range is the ship base (default 20 km, attr 458)
            // PLUS the character's accumulated skill bonus on the same attr.
            // Drone Avionics V + Advanced Drone Avionics V each ModAdd to
            // char.attr_458 via effect 504 (`domain: charID`). Pyfa reads
            // both and sums; ship.attr_458 alone misses 40 km of skills at
            // All-V → produces 20 km instead of the in-game 60 km.
            controlRange: ship.getFinal(ATTR.DRONE_CONTROL_RANGE, 20_000)
                        + ctx.character.getFinal(ATTR.DRONE_CONTROL_RANGE, 0),
        },
        projected: projectionReports,
        structure: computeStructureMeta(ctx),
        moduleSnapshots: snapshotModules(ctx),
    }
}

/** Per-module + per-charge final-attribute snapshot keyed by FitModule
 *  id. Built after the modifier pipeline runs so it reflects skills,
 *  hull bonuses, command bursts, system effects, charge crystals,
 *  etc. Only attribute IDs already populated on the ItemState are
 *  copied — keeps the snapshot proportional to the fit instead of
 *  bloating each module with the full ATTR enum. */
function snapshotModules(ctx: FitContext): Record<string, { module: Record<number, number>; charge: Record<number, number> | null }> {
    const out: Record<string, { module: Record<number, number>; charge: Record<number, number> | null }> = {}
    for (const m of ctx.modules) {
        const moduleSnap: Record<number, number> = {}
        for (const attrID of m.attrs.keys()) moduleSnap[attrID] = m.getFinal(attrID, 0)
        let chargeSnap: Record<number, number> | null = null
        if (m.charge) {
            chargeSnap = {}
            for (const attrID of m.charge.attrs.keys()) chargeSnap[attrID] = m.charge.getFinal(attrID, 0)
        }
        out[m.id] = { module: moduleSnap, charge: chargeSnap }
    }
    return out
}

function computeAlignTime(ship: ReturnType<typeof makeShipState>): number {
    const mass = ship.getFinal(ATTR.MASS, 0)
    const agility = ship.getFinal(ATTR.AGILITY, 0)
    if (!mass || !agility) return 0
    // EVE align-time formula: t = ln(4) × mass × inertia / 1e6.
    // ln(4) comes from solving v(t) = 0.75 × v_max in the linear-acceleration
    // model (warps at 75% velocity). ln(2) was wrong by a factor of 2 — Pyfa
    // and the in-game info show t = -ln(0.25) × ... = ln(4) × ...
    return Math.log(4) * mass * agility / 1_000_000
}

function pickSensorStrength(ship: ReturnType<typeof makeShipState>): {
    value: number
    type: 'radar' | 'ladar' | 'magnetometric' | 'gravimetric' | 'unknown'
} {
    const candidates: Array<{ attr: number; type: 'radar' | 'ladar' | 'magnetometric' | 'gravimetric' }> = [
        { attr: ATTR.SCAN_RADAR_STRENGTH, type: 'radar' },
        { attr: ATTR.SCAN_LADAR_STRENGTH, type: 'ladar' },
        { attr: ATTR.SCAN_MAGNETOMETRIC_STRENGTH, type: 'magnetometric' },
        { attr: ATTR.SCAN_GRAVIMETRIC_STRENGTH, type: 'gravimetric' },
    ]
    for (const c of candidates) {
        const v = ship.getFinal(c.attr, 0)
        if (v > 0) return { value: v, type: c.type }
    }
    return { value: 0, type: 'unknown' }
}
