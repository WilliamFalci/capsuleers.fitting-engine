/**
 * Core types for the fitting tool. Shared between:
 *  - the bundle (loaded into memory client-side from /public/fitting-data/)
 *  - the calc engine (modifier application, derived stats)
 *  - the UI components (slot rendering, picker, stats panels)
 *  - the API endpoints (fit save/load on Prisma)
 *
 * Naming convention: this file contains ONLY interfaces & enum-likes. No
 * runtime constants — those live in `constants.ts` so types can be imported
 * without pulling in code.
 */

// =============================================================================
// SDE bundle types — mirror the JSON shapes written by build-fitting-bundle.ts
// =============================================================================

export interface SdeAttribute {
    id: number
    name: string
    displayName?: string
    unitID?: number
    iconID?: number
    defaultValue: number
    highIsGood: boolean
    stackable: boolean
    attributeCategoryID?: number
    dataType?: number
}

export interface SdeUnit {
    id: number
    name: string
    displayName?: string
}

export interface SdeModifierInfo {
    /** Domain strings as they appear in the SDE — values observed:
     *  `itemID` (= self), `charID` (= the character/skills), `shipID`,
     *  `target` and `targetID` (both → projected target), `otherID`
     *  (charge ↔ module), `structureID`. The legacy aliases `'self'` and
     *  `'char'` are kept for places that historically wrote them by hand.
     *  All variants are normalised by `FitContext.resolveDomain`. */
    domain: 'self' | 'itemID' | 'char' | 'charID' | 'shipID' | 'target' | 'targetID' | 'otherID' | 'structureID'
    func:
      | 'ItemModifier'
      | 'LocationModifier'
      | 'LocationGroupModifier'
      | 'LocationRequiredSkillModifier'
      | 'OwnerRequiredSkillModifier'
      | 'EffectStopper'
    modifiedAttributeID?: number
    modifyingAttributeID?: number
    operation?: number
    groupID?: number
    skillTypeID?: number
    /** Only set on `func: 'EffectStopper'` modifiers. The numeric SDE
     *  effect ID this modifier suppresses on the target — e.g. warp
     *  scrambler / disruptor entries carry `effectID: 6441` (MWD) and
     *  `effectID: 6442` (MJD). Read by `collectEffectStoppers()` in the
     *  projection pre-pass. */
    effectID?: number
}

export interface SdeEffect {
    id: number
    name: string
    displayName?: string
    effectCategoryID?: number
    isOffensive: boolean
    isAssistance: boolean
    isWarpSafe: boolean
    durationAttributeID?: number
    dischargeAttributeID?: number
    rangeAttributeID?: number
    falloffAttributeID?: number
    trackingSpeedAttributeID?: number
    fittingUsageChanceAttributeID?: number
    resistanceAttributeID?: number
    distribution?: number
    propulsionChance: boolean
    electronicChance: boolean
    rangeChance: boolean
    disallowAutoRepeat: boolean
    guid?: string
    modifierInfo: SdeModifierInfo[]
}

export interface SdeMetaGroup {
    id: number
    name?: string
    color?: { r: number; g: number; b: number }
    iconID?: number
}

export interface SdeCategory { id: number; name?: string }
export interface SdeGroup { id: number; categoryID: number; name?: string }

/** EVE in-game Market window taxonomy node. Forms a tree via
 *  `parentGroupID`; root nodes have it undefined. The picker uses
 *  this hierarchy to render Module > Capacitor > Cap Battery the
 *  same way the in-game Market window does, instead of the flat
 *  SDE category > group fallback. */
export interface SdeMarketGroup {
    id: number
    name?: string
    parentGroupID?: number
    iconID?: number
    /** True iff items can sit directly under this node (vs. it being
     *  a pure folder grouping deeper market groups). Useful for
     *  picking the right level to show as the "leaf" subgroup. */
    hasTypes?: boolean
}

export interface SdeCloneGrade {
    id: number
    name: string
    skills: Array<{ typeID: number; level: number }>
}

export interface SdeDbuffCollection {
    id: number
    aggregateMode: 'Minimum' | 'Maximum' | 'Sum'
    operationName: string
    displayName?: string
    showOutputValueInUI?: 'ShowNormal' | 'ShowInverted' | 'Hide'
    itemModifiers: Array<{ dogmaAttributeID: number }>
    locationModifiers: Array<{ dogmaAttributeID: number }>
    locationGroupModifiers: Array<{ dogmaAttributeID: number; groupID: number }>
    locationRequiredSkillModifiers: Array<{ dogmaAttributeID: number; skillID: number }>
}

export interface SdeDynamicAttribute {
    id: number
    attributeIDs: Array<{ id: number; min: number; max: number }>
    inputOutputMapping: Array<{ applicableTypes: number[]; resultingType: number }>
}

export interface SdeType {
    id: number
    name?: string
    groupID: number
    categoryID: number
    marketGroupID?: number
    iconID?: number
    metaGroupID?: number
    metaLevel?: number
    variationParentTypeID?: number
    mass?: number
    volume?: number
    capacity?: number
    portionSize?: number
    basePrice?: number
    attributes: Array<{ id: number; v: number }>
    effects: Array<{ id: number; def: 0 | 1 }>
}

export interface BundleManifest {
    version: string
    builtAt: string
    totalBytes: number
    files: Record<string, { bytes: number; entries: number }>
}

// Aggregated handle returned by the bundle loader. Modules of the engine
// consume this — a single typed object instead of dozens of free maps.
export interface FittingDataset {
    version: string
    attributes: Map<number, SdeAttribute>
    units: Map<number, SdeUnit>
    effects: Map<number, SdeEffect>
    metaGroups: Map<number, SdeMetaGroup>
    categories: Map<number, SdeCategory>
    groups: Map<number, SdeGroup>
    /** EVE Market-window hierarchy. Pickers walk the parent-chain
     *  from a type's `marketGroupID` up to the root to render the
     *  same tree the user sees in-game (Modules → Capacitor →
     *  Capacitor Battery). Empty when the loaded bundle predates
     *  market-group support. */
    marketGroups: Map<number, SdeMarketGroup>
    cloneGrades: Map<number, SdeCloneGrade>
    dbuffCollections: Map<number, SdeDbuffCollection>
    dynamicAttributes: Map<number, SdeDynamicAttribute>
    // Type buckets are loaded lazily — only "ships" is needed for the picker
    // entry-point; modules/charges arrive on demand. `getType()` resolves
    // across loaded buckets.
    typesByBucket: Partial<Record<TypeBucket, Map<number, SdeType>>>
    /** Resolves a type from any already-loaded bucket. */
    getType(id: number): SdeType | undefined
    /** Lazily loads a bucket if not already in memory. */
    loadBucket(bucket: TypeBucket): Promise<Map<number, SdeType>>
}

export type TypeBucket = 'ships' | 'modules' | 'charges' | 'drones' | 'fighters' | 'implants' | 'subsystems' | 'skills' | 'systemEffects' | 'structures' | 'structureModules' | 'mutaplasmids'

// =============================================================================
// Fit model — what the user composes in the editor + saves to DB
// =============================================================================

export type SlotType = 'HI' | 'MED' | 'LO' | 'RIG' | 'SUBSYSTEM' | 'SERVICE'
export type ModuleState = 'OFFLINE' | 'ONLINE' | 'ACTIVE' | 'OVERLOAD'
export type FitVisibility = 'PRIVATE' | 'PUBLIC' | 'LINK'

export interface MutatorData {
    /** Mutaplasmid (dynamicItemAttribute) type id used to mutate this module. */
    dynamicTypeID: number
    /** User-picked attribute values within the mutaplasmid's min/max range. */
    attributes: Record<number, number>
    /** Source module type the abyssal was created from. The fit's
     *  `module.typeID` swaps to the mutaplasmid's `resultingType` (e.g.
     *  "Abyssal Warp Disruptor") on apply; this preserves the original
     *  type so the editor can: (a) reuse the source's base attribute
     *  values to compute slider ranges when re-editing, (b) restore
     *  the original module typeID when the user clears the mutator. */
    sourceTypeID?: number
}

export interface FitModule {
    /** Stable id within the fit (uuid client-side, db id server-side). */
    id: string
    slotType: SlotType
    /** 0-indexed position within the slot type (max 8). */
    position: number
    typeID: number
    state: ModuleState
    chargeTypeID?: number
    mutator?: MutatorData
}

export interface FitDrone {
    id: string
    typeID: number
    countTotal: number
    countActive: number
}

export interface FitFighter {
    id: string
    typeID: number
    count: number
    abilityState: Record<number, boolean>
}

export interface FitCargo {
    id: string
    typeID: number
    count: number
}

export interface FitImplant {
    id: string
    typeID: number
    slot: number  // 1-10
}

export interface FitBooster {
    id: string
    typeID: number
    slot: number  // 1-3
    activeSideEffects: number[]
}

export interface FitSubsystem {
    id: string
    slot: number  // 1-5 (T3C)
    typeID: number
}

export interface DamageProfile {
    id?: string
    name: string
    em: number
    thermal: number
    kinetic: number
    explosive: number
    isPreset?: boolean
}

export interface TargetProfile {
    id?: string
    name: string
    signatureRadius: number
    maxVelocity: number
    emResist: number
    thermalResist: number
    kineticResist: number
    explosiveResist: number
    isPreset?: boolean
}

export interface SkillProfile {
    id?: string
    name: string
    isDefault: boolean
    source: 'manual' | 'esi' | 'preset'
    sourceCharacterID?: string
    /** typeID → 0..5. Sparse map; missing skills assumed level 0. */
    skills: Record<number, 0 | 1 | 2 | 3 | 4 | 5>
    syncedAt?: string
}

export interface Fit {
    id?: string
    discordUserID?: string
    shipTypeID: number
    name: string
    description?: string
    visibility: FitVisibility
    shareSlug?: string
    damageProfileID?: string
    targetProfileID?: string
    skillProfileID?: string
    authorCharacterID?: string
    authorName?: string
    authorCorpID?: string
    authorCorpName?: string
    tags: string[]
    modules: FitModule[]
    drones: FitDrone[]
    fighters: FitFighter[]
    cargo: FitCargo[]
    implants: FitImplant[]
    boosters: FitBooster[]
    subsystems: FitSubsystem[]
    /** T3D / T3C exclusive mode type id, if any. */
    modeTypeID?: number
    createdAt?: string
    updatedAt?: string
}

// =============================================================================
// Calc engine types
// =============================================================================

/**
 * Every modifier applied by the engine carries one of these operations.
 * Maps 1:1 to EVE's dogma operation enum. Order is significant — pipeline
 * applies them in this exact sequence per attribute.
 */
export type ModifierOperation =
    | 'PreAssign'   // -1 in SDE: set base, allow further mods
    | 'PreMul'      //  0
    | 'PreDiv'      //  1
    | 'ModAdd'      //  2: additive
    | 'ModSub'      //  3
    | 'PostMul'     //  4
    | 'PostDiv'     //  5
    | 'PostPercent' //  6: + (value × 100) %
    | 'PostAssign'  //  7: overwrites everything

export interface ModifierAffliction {
    sourceKind: 'module' | 'skill' | 'ship' | 'implant' | 'booster' | 'mode' | 'projected' | 'fleet' | 'drone' | 'fighter' | 'subsystem'
    sourceID: string
    operation: ModifierOperation
    value: number
    /** Stacking penalty group key. null = unstacked. */
    stackingGroup: string | null
    /** Optional resistance attribute applied to this modifier (projected effects). */
    resistanceAttributeID?: number
}

export interface ComputedAttribute {
    id: number
    base: number
    final: number
    afflictions: ModifierAffliction[]
}

/** What computeFit returns — the full derived view of a fit. */
export interface ComputedFit {
    fit: Fit
    /** Computed attributes for the ship itself (capacity, max velocity, etc). */
    ship: Map<number, ComputedAttribute>
    /** Per-module computed state (modified attributes after skills + ship bonuses + module bonuses). */
    modules: Map<string, ModuleComputed>
    drones: Map<string, DroneComputed>
    fighters: Map<string, FighterComputed>
    derived: DerivedStats
}

export interface ModuleComputed {
    fitModuleID: string
    typeID: number
    slotType: SlotType
    state: ModuleState
    attributes: Map<number, ComputedAttribute>
    /** Effective CPU/PG cost (modifiable by Engineering skills). */
    effectiveCpu: number
    effectivePower: number
}

export interface DroneComputed {
    fitDroneID: string
    typeID: number
    attributes: Map<number, ComputedAttribute>
    /** DPS contribution from this drone group (per-drone × count). */
    dps: number
}

export interface FighterComputed {
    fitFighterID: string
    typeID: number
    attributes: Map<number, ComputedAttribute>
    abilities: Array<{ effectID: number; enabled: boolean; dps: number }>
}

export interface DerivedStats {
    fitting: {
        cpuUsed: number
        cpuMax: number
        powerUsed: number
        powerMax: number
        calibrationUsed: number
        calibrationMax: number
        droneBandwidthUsed: number
        droneBandwidthMax: number
        droneBayUsed: number
        droneBayMax: number
        slots: Record<SlotType, { used: number; max: number }>
        /** Per-weapon-class hardpoint accounting. Turrets and launchers
         *  consume separate physical mount points on the hull (attrs
         *  `turretHardpoints` 102 and `launcherHardpoints` 101). HI
         *  modules that are NEITHER turret nor launcher (smartbombs,
         *  EWAR bursts, command bursts, cloaks, MJD…) consume a HI
         *  slot but no hardpoint. */
        hardpoints: {
            turret:   { used: number; max: number }
            launcher: { used: number; max: number }
        }
    }
    defense: {
        shield: { hp: number; ehpUniform: number; ehpAgainstProfile: number; resistances: { em: number; thermal: number; kinetic: number; explosive: number } }
        armor:  { hp: number; ehpUniform: number; ehpAgainstProfile: number; resistances: { em: number; thermal: number; kinetic: number; explosive: number } }
        hull:   { hp: number; ehpUniform: number; ehpAgainstProfile: number; resistances: { em: number; thermal: number; kinetic: number; explosive: number } }
        ehpTotalAgainstProfile: number
    }
    offense: {
        weaponDps: number
        /** Reload-amortised weapon DPS. */
        weaponSustainedDps: number
        droneDps: number
        fighterDps: number
        totalDps: number
        /** Reload-amortised total DPS (weapons + drones). */
        totalSustainedDps: number
        alphaStrike: number
        weaponOptimal: number
        weaponFalloff: number
        weaponTracking?: number
        explosionVelocity?: number  // missiles
        explosionRadius?: number    // missiles
        breakdown: WeaponContribution[]
    }
    capacitor: {
        capacity: number
        rechargeMs: number
        peakRechargeRate: number
        usagePerSecond: number
        stable: boolean
        stablePercent: number  // 0..1
        secondsToEmpty?: number
    }
    tank: {
        shieldRepairAmount: number
        shieldRepairDuration: number
        shieldRepairPerSecond: number
        /** Reload-amortised shield rep/sec (paste-fueled AAR / cap-fueled
         *  ASB modulate this lower than peak). */
        shieldRepairPerSecondSustained: number
        armorRepairAmount: number
        armorRepairDuration: number
        armorRepairPerSecond: number
        armorRepairPerSecondSustained: number
        hullRepairAmount: number
        hullRepairDuration: number
        hullRepairPerSecond: number
        hullRepairPerSecondSustained: number
        passiveShieldRegenPeak: number
    }
    navigation: {
        maxVelocity: number
        mass: number
        agility: number
        alignTimeSeconds: number
        warpSpeed: number
    }
    targeting: {
        maxTargetingRange: number
        maxLockedTargets: number
        signatureRadius: number
        scanResolution: number
        sensorStrength: number
        sensorType: 'radar' | 'ladar' | 'magnetometric' | 'gravimetric' | 'unknown'
    }
    drones: {
        bayUsed: number
        bayMax: number
        bandwidthUsed: number
        bandwidthMax: number
        active: number
        controlRange: number
    }
    /** Active projected effects from the ProjectedSource list. Empty when
     *  no projection is configured. */
    projected: ProjectedEffectReport[]
    /** Upwell-structure metadata. Populated only when the host typeID
     *  resolves to a category=65 type; null for ship fits. Carries the
     *  service-slot summary + total fuel-block consumption across all
     *  online service modules. */
    structure: StructureMeta | null
    /** Per-module final-attribute snapshot keyed by `Fit.modules[i].id`.
     *  The engine writes the final (post-skill, post-hull-bonus,
     *  post-modifier-pipeline) value of every attribute on each
     *  module + its loaded charge after `applySourceItem` runs.
     *  Consumed by the hover popover to show user-meaningful values
     *  ("3.6 km optimal" with skill bonuses) instead of raw SDE base
     *  values. Each entry is `{ module: Map<attrID, finalValue>,
     *  charge: Map<attrID, finalValue> | null }`. */
    moduleSnapshots: Record<string, ModuleAttrSnapshot>
}

export interface ModuleAttrSnapshot {
    module: Record<number, number>
    charge: Record<number, number> | null
}

export interface StructureServiceModule {
    /** Index of the module in `Fit.modules`. */
    moduleIndex: number
    typeID: number
    name: string
    /** ONLINE / ACTIVE / OFFLINE — only ONLINE+ contributes fuel. */
    state: 'OFFLINE' | 'ONLINE' | 'ACTIVE' | 'OVERLOAD'
    /** Per-hour fuel block cost (attr 2109 serviceModuleFuelAmount).
     *  Zero when the module is OFFLINE. */
    fuelBlocksPerHour: number
}

export interface StructureMeta {
    /** Service-slot capacity from the host hull (attr 2056). */
    serviceSlotsMax: number
    /** Number of modules currently fitted in a SERVICE slot (regardless
     *  of state). */
    serviceSlotsUsed: number
    /** Sum of `serviceModuleFuelAmount` across modules whose state is
     *  ONLINE or above. Per-hour rate. */
    fuelBlocksPerHour: number
    /** Per-service-module breakdown for the UI. */
    services: StructureServiceModule[]
}

/** Result of computeFit when the engine cannot compute a portion (missing
 *  data, malformed fit, etc.). Captures partial results + warnings. */
export interface FitWarning {
    code: string
    message: string
    sourceID?: string
}

/**
 * Projected source — a hostile module/drone applying its effects to the fit
 * being computed. Modelled as a typeID + state + optional charge so the
 * same modifier engine can dispatch (with `domain: 'targetID'` resolving to
 * the fit's own ship as the target). Used for previewing PvP scenarios:
 * "what does my ship look like under ECM / web / damp?".
 */
export interface ProjectedSource {
    id: string
    typeID: number
    state: ModuleState
    chargeTypeID?: number
    mutator?: MutatorData
    /** Distance in meters between attacker and target. Optional — if
     *  unset the engine treats the projection as in-optimal (full effect,
     *  factor = 1). For falloff-projected EWAR (web/damp/paint/track/
     *  guidance) the engine applies `0.5 ** ((max(0, distance - optimal)
     *  / falloff) ** 2)` and clamps to 0 past `optimal + 3 × falloff`. */
    projectionRange?: number
}

/** Summary of an active projected effect — surfaced so the UI can render
 *  "you're being jammed at X% per cycle" / "your tracking is reduced". */
export interface ProjectedEffectReport {
    /** Source projected module type. */
    typeID: number
    /** What kind of EWAR this is. */
    kind: 'ECM' | 'SENSOR_DAMP' | 'TRACKING_DISRUPT' | 'WEB' | 'WARP_SCRAM' | 'WARP_DISRUPT' | 'NEUT' | 'NOS' | 'OTHER' | 'REMOTE_REP_SHIELD' | 'REMOTE_REP_ARMOR' | 'REMOTE_REP_HULL' | 'REMOTE_CAP'
    /** Per-cycle jam probability (0..1) — only ECM. */
    jamChance?: number
    /** Per-second healing received on the relevant layer (REMOTE_REP_*) or
     *  per-second cap drain (positive = drain, negative = injection) for
     *  REMOTE_CAP / NEUT / NOS. */
    perSecond?: number
    /** Free-form summary the UI can render verbatim. */
    summary: string
}

/**
 * Per-weapon DPS / range breakdown row. Aggregated into DerivedStats.offense
 * by `derived/offense.ts::computeOffense`. The UI uses this to render a
 * "weapon by weapon" listing under the offense tab + to drive the
 * "max engagement range" / "tracking limit" badges.
 */
export type WeaponKind = 'TURRET' | 'MISSILE' | 'SMARTBOMB' | 'DOOMSDAY' | 'DRONE'

export interface WeaponContribution {
    sourceID: string
    typeID: number
    name?: string
    kind: WeaponKind
    /** Single-volley damage (sum across all weapons of this row's count). */
    alpha: number
    /** Peak DPS — alpha / cycle. Burst rate during the active firing window. */
    dps: number
    /** DPS amortised across reload windows. For weapons with frequent reloads
     *  (lasers, cap boosters, capital weapons) this is meaningfully lower
     *  than `dps`. For HAM/cruise launchers the difference is < 1 %. Equals
     *  `dps` when no charge / no reload model. */
    sustainedDps?: number
    /** Reload time in seconds (parsed from module's `reloadTime` attribute
     *  or assigned a 1 s default by Pyfa-parity legacy effects 10/34/67/
     *  101/6995). */
    reloadSeconds?: number
    /** Charges per loadout — `floor(launcher_capacity / charge_volume)`. */
    chargesPerLoad?: number
    /** Vorton Projector ONLY — best-case chain DPS assuming `arcTargets`
     *  are within range. Computed as a geometric series of base DPS:
     *  Σ(base × (1 - reduction)^k) for k=0..N-1. */
    chainDpsMax?: number
    /** Vorton Projector ONLY — number of chain targets (e.g. 10). */
    chainTargetCount?: number
    cycleSeconds: number
    damages: { em: number; thermal: number; kinetic: number; explosive: number; total: number }
    range: {
        optimal: number
        falloff: number
        tracking: number
        burstRange: number
        explosionRadius: number
        explosionVelocity: number
        drf: number
    }
    chargeTypeID?: number
    count: number
    /** Triglavian disintegrator (effect 6995) spool data. Carries the
     *  fully-modified max bonus (attr 2734 post-ship-hull boosts like
     *  Babaroga's +20%/level Large Precursor Weapon) and the per-cycle
     *  bonus (attr 2733). The UI reads these to render the spool slider's
     *  Min/Max DPS columns and the time-to-full-spool readout without
     *  re-running the engine. Absent on every other weapon kind. */
    disintegrator?: {
        maxBonus: number
        bonusPerCycle: number
        /** DPS at spool=0 (cold start). Computed by the engine from the
         *  current `dps` and the spool factor used in this very compute
         *  pass — `baseDps = dps / (1 + currentSpoolPct × maxBonus)`.
         *  Storing it here makes the slider Min/Max readouts INVARIANT to
         *  the slider position: both Min (= baseDps) and Max (= baseDps ×
         *  (1 + maxBonus)) come straight from this field, instead of the
         *  UI reverse-engineering them on every render — which produced a
         *  visible drift while the debounced engine recompute was
         *  in-flight. */
        baseDps: number
    }
}
