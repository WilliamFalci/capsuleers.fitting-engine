/**
 * Well-known EVE Online dogma constants used by the fitting engine.
 *
 * These are stable IDs that have been carried since the SDE existed (2010+).
 * Fenris Creations occasionally adds new attributes/effects but never reuses or renames
 * existing ones. This file is the single source of truth — no other module
 * should hardcode these numeric IDs.
 *
 * Sources:
 *  - Pyfa's `eos/const.py` for the canonical list
 *  - EVE Reference / EVE Online Static Data Export documentation
 *  - Cross-referenced against our /server/data/SDE/dogma{Attributes,Effects}.jsonl
 */

import type { ModifierOperation } from './types'

// =============================================================================
// SDE category IDs that the fitting tool surfaces
// =============================================================================
export const CATEGORY = {
    SHIP: 6,
    MODULE: 7,
    CHARGE: 8,
    SKILL: 16,
    DRONE: 18,
    IMPLANT: 20,        // includes BOOSTER groups (split via groupID at runtime)
    SUBSYSTEM: 32,
    FIGHTER: 87,
    STRUCTURE_MODULE: 66, // Citadel modules — same engine semantics as Module
} as const

// =============================================================================
// Operation enum: maps SDE numeric op codes to our string identifiers.
// Pipeline order is significant — see ModifiedAttribute.compute().
// =============================================================================
export const OPERATION_BY_SDE_CODE: Record<number, ModifierOperation> = {
    [-1]: 'PreAssign',
    0: 'PreMul',
    1: 'PreDiv',
    2: 'ModAdd',
    3: 'ModSub',
    4: 'PostMul',
    5: 'PostDiv',
    6: 'PostPercent',
    7: 'PostAssign',
}

export const OPERATION_NAMES_BY_SDE_NAME: Record<string, ModifierOperation> = {
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

/** Operations handled by the multiplicative pipeline (subject to stacking penalty). */
export const MULTIPLICATIVE_OPS: readonly ModifierOperation[] = ['PreMul', 'PreDiv', 'PostMul', 'PostDiv', 'PostPercent']

/** Operations handled by the additive pipeline (no stacking penalty). */
export const ADDITIVE_OPS: readonly ModifierOperation[] = ['ModAdd', 'ModSub']

// =============================================================================
// Slot identifying effects. These effects, when present on a module,
// determine which slot type the module fits into.
// =============================================================================
export const SLOT_EFFECT_ID = {
    LO_POWER: 11,
    HI_POWER: 12,
    MED_POWER: 13,
    RIG_SLOT: 2663,
    SUBSYSTEM: 3772,
    SERVICE_SLOT: 6306,
} as const

export const SLOT_EFFECT_TO_SLOT_TYPE: Record<number, 'HI' | 'MED' | 'LO' | 'RIG' | 'SUBSYSTEM' | 'SERVICE'> = {
    [SLOT_EFFECT_ID.LO_POWER]: 'LO',
    [SLOT_EFFECT_ID.HI_POWER]: 'HI',
    [SLOT_EFFECT_ID.MED_POWER]: 'MED',
    [SLOT_EFFECT_ID.RIG_SLOT]: 'RIG',
    [SLOT_EFFECT_ID.SUBSYSTEM]: 'SUBSYSTEM',
    [SLOT_EFFECT_ID.SERVICE_SLOT]: 'SERVICE',
}

// =============================================================================
// Module activation effects: their presence indicates the module can be
// activated (state ACTIVE/OVERLOAD), and they reference duration/discharge
// attributes for cap drain + cycle time.
// =============================================================================
export const ACTIVATION_EFFECT_ID = {
    ONLINE_FOR_STRUCTURES: 16,
    ONLINE: 16,                 // alias
    LASER_TURRET: 10,           // targetAttack with laser projection
    PROJECTILE_TURRET: 34,
    HYBRID_TURRET: 35,
    MISSILE_LAUNCH: 87,         // missileLaunching
    MISSILE_LAUNCH_DUMB: 4947,
    DRONE_DAMAGE_AMP: 5379,
    SHIELD_BOOSTING: 4,
    SHIELD_BOOSTING_FUELED: 4936,  // ancillary shield booster
    ARMOR_REPAIR: 27,
    ARMOR_REPAIR_FUELED: 5275,     // ancillary armor repairer
    HULL_REPAIR: 26,               // structureRepair
    AB_THRUST: 6,               // afterburner activation
    MWD_THRUST: 8,              // microwarpdrive
    SHIELD_TRANSFER: 18,
    ARMOR_TRANSFER: 592,        // remote armor rep
    REMOTE_CAP_TRANSFER: 31,
    NOSFERATU: 1,
    WEB_TARGETED: 14,           // statisWeb
    WARP_SCRAMBLER: 19,
    SENSOR_DAMP: 1130,
    TRACKING_DISRUPTOR: 1799,
    ECM: 1786,
    ENERGY_NEUTRALIZE: 28,
} as const

// =============================================================================
// Weapon effect classification.
//
// Turret weapons (lasers / projectiles / hybrids) all share the same damage
// application model: damage_per_cycle = sum(charge_damage) × damageMultiplier,
// with optimal/falloff/tracking on the launcher itself (modified by ammo).
//
// Missile launchers fire charges directly — no damageMultiplier baked in
// (skill bonuses can add a multiplier via modifierInfo).
//
// Smart bombs (empWave) are AoE bursts — same damage shape as turrets but
// with a fixed range and no tracking.
// =============================================================================
export type WeaponEffectKind = 'TURRET' | 'MISSILE' | 'SMARTBOMB' | 'DOOMSDAY'

export const WEAPON_EFFECT_KIND: Record<number, WeaponEffectKind> = {
    10:   'TURRET',    // targetAttack — lasers + hybrids
    34:   'TURRET',    // projectileFired — projectile turrets
    6995: 'TURRET',    // targetDisintegratorAttack — Triglavian entropic
                       //   disintegrators. Structurally a turret-class
                       //   weapon (cat 2, duration/range/tracking attrs)
                       //   but with a damage spool-up not yet modelled —
                       //   DPS is computed at base damageMultiplier so
                       //   our number is the unspooled minimum; Pyfa's
                       //   default display is full-spool which is
                       //   typically 3-5× higher.
    8037: 'TURRET',    // ChainLightning — ship-side Vorton Projector. Loaded
                       //   with Vorton charges; rate of fire from attr 51,
                       //   damage from charge, optimal/falloff from
                       //   `rangeAttributeID`. Chain-DPS multiplier from
                       //   `derived/offense::weaponContributionFor`.
    9:    'MISSILE',   // missileLaunching (legacy / fighter bombs)
    101:  'MISSILE',   // useMissiles (modern launchers)
    38:   'SMARTBOMB', // empWave
    6447: 'SMARTBOMB', // lightningWeapon — Standup Arcing Vorton Projector
                       //   (XL structure weapon). Damage attrs sit on the
                       //   module itself (no charge), cycle = attr 73
                       //   `duration`. Chain-DPS multiplier reuses the
                       //   weapon contribution path with structure-specific
                       //   target/retention attrs (2104 / 2106).
}

// Repair effect → repaired-attribute lookup. The effect's
// durationAttributeID gives the cycle time per module; the amount attribute
// listed here gives the per-cycle repair value.
export const REPAIR_EFFECT_AMOUNT_ATTR: Record<number, { amountAttr: number; layer: 'SHIELD' | 'ARMOR' | 'HULL' }> = {
    [ACTIVATION_EFFECT_ID.SHIELD_BOOSTING]:        { amountAttr: 68, layer: 'SHIELD' },  // shieldBonus
    [ACTIVATION_EFFECT_ID.SHIELD_BOOSTING_FUELED]: { amountAttr: 68, layer: 'SHIELD' },  // ancillary
    [ACTIVATION_EFFECT_ID.ARMOR_REPAIR]:           { amountAttr: 84, layer: 'ARMOR' },   // armorDamageAmount
    [ACTIVATION_EFFECT_ID.ARMOR_REPAIR_FUELED]:    { amountAttr: 84, layer: 'ARMOR' },   // ancillary
    [ACTIVATION_EFFECT_ID.HULL_REPAIR]:            { amountAttr: 83, layer: 'HULL' },    // structureDamageAmount
}

// =============================================================================
// Attribute IDs grouped by purpose. Used by both the calc engine and the UI
// (existing ShipStats.vue already references many of these inline).
// =============================================================================
export const ATTR = {
    // ---- Hull / mass / volume ----
    MASS: 4,
    HP: 9,                      // structure hitpoints
    AGILITY: 70,
    VOLUME: 161,                // packaged volume
    CAPACITY: 38,               // cargo hold (also used as drone bay on some ships)

    // ---- Fitting ----
    POWER_OUTPUT: 11,
    POWER_USED: 30,             // capPowerLoad? Actually base power output is 11 on ships. Module use is 30
    CPU_OUTPUT: 48,
    CPU_USED: 50,
    UPGRADE_CAPACITY: 1132,     // calibration max
    UPGRADE_COST: 1153,         // calibration used per rig
    DRONE_BANDWIDTH: 1271,
    DRONE_CAPACITY: 283,

    // ---- Slots (ship attributes telling how many slots) ----
    HI_SLOTS: 14,
    MED_SLOTS: 13,
    LOW_SLOTS: 12,
    RIG_SLOTS: 1137,
    SUBSYSTEM_SLOTS: 1367,
    SERVICE_SLOTS: 2056,
    LAUNCHER_HARDPOINTS: 101,
    TURRET_HARDPOINTS: 102,
    RIG_SIZE: 1547,             // small/medium/large/xlarge

    /** Per-ship cap on how many modules of THIS ITEM'S group can be fitted.
     *  e.g. Medium Breacher Pod Launcher carries `maxGroupFitted = 1`, so
     *  only one of its group (`Breacher Pod Launcher`) is allowed per hull,
     *  even if the ship has multiple launcher hardpoints. */
    MAX_GROUP_FITTED: 1544,
    /** Per-ship cap on how many modules of THIS EXACT typeID can be fitted.
     *  Sibling of MAX_GROUP_FITTED — used by a small set of unique-named
     *  modules (Bastion Module, certain doomsday weapons). */
    MAX_TYPE_FITTED: 2487,

    // ---- Capacitor ----
    CAPACITOR_CAPACITY: 482,
    CAPACITOR_RECHARGE_RATE: 55,  // ms

    // ---- Shield ----
    SHIELD_CAPACITY: 263,
    SHIELD_RECHARGE_RATE: 479,    // ms
    SHIELD_EM_RES: 271,
    SHIELD_THERMAL_RES: 274,
    SHIELD_KINETIC_RES: 273,
    SHIELD_EXPLOSIVE_RES: 272,

    // ---- Armor ----
    ARMOR_HP: 265,
    ARMOR_EM_RES: 267,
    ARMOR_THERMAL_RES: 270,
    ARMOR_KINETIC_RES: 269,
    ARMOR_EXPLOSIVE_RES: 268,

    // ---- Structure / hull ----
    STRUCTURE_EM_RES: 113,
    STRUCTURE_THERMAL_RES: 110,
    STRUCTURE_KINETIC_RES: 109,
    STRUCTURE_EXPLOSIVE_RES: 111,

    // ---- Targeting ----
    MAX_TARGET_RANGE: 76,
    /** Theoretical maximum-targeting-range cap (`maximumRangeCap`). Default
     *  300 km; raised by Sensor Array / Sensor Booster overload etc. via
     *  PreAssign on attr 797. The SDE encodes this as `maxAttributeID=797`
     *  on attr 76 — clamping is applied at the engine read site. */
    MAX_TARGET_RANGE_CAP: 797,
    MAX_LOCKED_TARGETS: 192,
    SIGNATURE_RADIUS: 552,
    SCAN_RESOLUTION: 564,
    SCAN_RADAR_STRENGTH: 208,
    SCAN_LADAR_STRENGTH: 209,
    SCAN_MAGNETOMETRIC_STRENGTH: 210,
    SCAN_GRAVIMETRIC_STRENGTH: 211,
    DRONE_CONTROL_RANGE: 458,    // skill / module-modified ship attr; was
                                 // missing here so Drone Sharpshooting and
                                 // Drone Range Augmentor rigs were silently
                                 // ignored by the modifier dispatcher.

    // ---- Navigation ----
    MAX_VELOCITY: 37,
    WARP_SPEED_MULTIPLIER: 600,

    // ---- Damage ----
    DAMAGE_MULTIPLIER: 64,
    EM_DAMAGE: 114,
    THERMAL_DAMAGE: 118,
    KINETIC_DAMAGE: 117,
    EXPLOSIVE_DAMAGE: 116,
    OPTIMAL_RANGE: 54,
    FALLOFF_RANGE: 158,
    TRACKING_SPEED: 160,
    RATE_OF_FIRE: 51,            // duration ms
    DAMAGE_DURATION: 73,         // alias for some effects

    // ---- Missiles ----
    MISSILE_DAMAGE_MULTIPLIER: 212,  // charge attr — boosted by BCS effect 763 (PreMul attr_213 → 212)
    EXPLOSION_VELOCITY: 653,
    EXPLOSION_RADIUS: 654,
    DRF: 858,                    // damage reduction factor

    // ---- Breacher Pods (DOT charges, e.g. SCARAB Breacher Pod M) ----
    DOT_DURATION: 5735,                  // ms
    DOT_MAX_DAMAGE_PER_TICK: 5736,       // GJ cap per second
    DOT_MAX_HP_PERCENTAGE_PER_TICK: 5737, // % of target HP per second

    // ---- Charges ----
    CHARGE_GROUP_1: 604,
    CHARGE_GROUP_2: 605,
    CHARGE_GROUP_3: 606,
    CHARGE_GROUP_4: 609,
    CHARGE_GROUP_5: 610,
    CHARGE_SIZE: 128,

    // ---- Skills (skill type IDs encoded as attribute values) ----
    REQUIRED_SKILL_1: 182,
    REQUIRED_SKILL_2: 183,
    REQUIRED_SKILL_3: 184,
    REQUIRED_SKILL_4: 1285,
    REQUIRED_SKILL_5: 1289,
    REQUIRED_SKILL_6: 1290,
    REQUIRED_SKILL_1_LEVEL: 277,
    REQUIRED_SKILL_2_LEVEL: 278,
    REQUIRED_SKILL_3_LEVEL: 279,
    REQUIRED_SKILL_4_LEVEL: 1286,
    REQUIRED_SKILL_5_LEVEL: 1287,
    REQUIRED_SKILL_6_LEVEL: 1288,

    // ---- Drones ----
    MAX_ACTIVE_DRONES: 352,      // skill: drones max active count

    // ---- Maxima / caps ----
    MAX_VELOCITY_LIMIT: 192,
    MAX_RANGE_LIMIT: 192,

    // ---- Fitting restrictions (module-side attributes that gate fitting) ----
    // canFitShipGroup1-9: module fits only on ships of these groupIDs.
    CAN_FIT_SHIP_GROUP_1: 1298,
    CAN_FIT_SHIP_GROUP_2: 1299,
    CAN_FIT_SHIP_GROUP_3: 1300,
    CAN_FIT_SHIP_GROUP_4: 1301,
    CAN_FIT_SHIP_GROUP_5: 1872,
    CAN_FIT_SHIP_GROUP_6: 1879,
    CAN_FIT_SHIP_GROUP_7: 1880,
    CAN_FIT_SHIP_GROUP_8: 1881,
    CAN_FIT_SHIP_GROUP_9: 2065,
    // canFitShipType1-4: module fits only on these specific ship typeIDs.
    CAN_FIT_SHIP_TYPE_1: 1302,
    CAN_FIT_SHIP_TYPE_2: 1303,
    CAN_FIT_SHIP_TYPE_3: 1304,
    CAN_FIT_SHIP_TYPE_4: 1305,
} as const

/** Module attribute IDs that, if present and non-zero, restrict the
 *  module to fit only on ships whose groupID is among the listed values. */
export const CAN_FIT_SHIP_GROUP_ATTRS: readonly number[] = [
    1298, 1299, 1300, 1301, 1872, 1879, 1880, 1881, 2065,
]

/** Module attribute IDs that, if present and non-zero, restrict the
 *  module to fit only on ships whose typeID is among the listed values. */
export const CAN_FIT_SHIP_TYPE_ATTRS: readonly number[] = [
    1302, 1303, 1304, 1305,
]

/** Pairs of (skill_attr_id, level_attr_id). Used by skill-requirement derivation. */
export const REQUIRED_SKILL_PAIRS: ReadonlyArray<readonly [number, number]> = [
    [ATTR.REQUIRED_SKILL_1, ATTR.REQUIRED_SKILL_1_LEVEL],
    [ATTR.REQUIRED_SKILL_2, ATTR.REQUIRED_SKILL_2_LEVEL],
    [ATTR.REQUIRED_SKILL_3, ATTR.REQUIRED_SKILL_3_LEVEL],
    [ATTR.REQUIRED_SKILL_4, ATTR.REQUIRED_SKILL_4_LEVEL],
    [ATTR.REQUIRED_SKILL_5, ATTR.REQUIRED_SKILL_5_LEVEL],
    [ATTR.REQUIRED_SKILL_6, ATTR.REQUIRED_SKILL_6_LEVEL],
]

// =============================================================================
// Charge group attribute IDs (the 5 attributes that list which charge groups
// a module accepts). When loading a charge into a module, the charge's
// groupID must match one of these.
// =============================================================================
export const CHARGE_GROUP_ATTRS: readonly number[] = [
    ATTR.CHARGE_GROUP_1, ATTR.CHARGE_GROUP_2, ATTR.CHARGE_GROUP_3,
    ATTR.CHARGE_GROUP_4, ATTR.CHARGE_GROUP_5,
]

// =============================================================================
// Stacking penalty constants. EVE's formula: 1 + (mult - 1) × exp(-i² / k)
// where i = position (0-indexed), k = 7.1289.
// Reference: https://wiki.eveuniversity.org/Stacking_penalties
// =============================================================================
export const STACKING_PENALTY_K = 7.1289

// =============================================================================
// LEGACY_EFFECT_IDS — central registry of every SDE effect ID claimed by a
// hardcoded handler (modifierEngine `applyLegacy*` family, derived modules, or
// projection-EWAR/remote-rep/cap-warfare/ECM def tables). Each entry pins the
// numeric ID to its expected SDE effectName so a future Fenris Creations renumber surfaces
// loudly via `verifyLegacyEffectIds(dataset)` instead of silently no-opping.
//
// Format: { id, name, handler }. `name` is the SDE `effectName` field — null
// means the effect name was not exported for this ID in modern SDE bundles
// (verified empty in v0f768e6c9ace) and the entry is identity-only. `handler`
// is a free-form label naming the function or table that consumes the ID;
// purely descriptive, used by the audit script when listing per-ID coverage.
//
// Keep this list SORTED BY ID for diff readability. When adding a new
// hardcoded handler, register the IDs here BEFORE writing the handler — the
// audit script picks up the new entry on the next pass.
// =============================================================================
export interface LegacyEffectEntry {
    /** SDE effect ID. */
    id: number
    /** Expected SDE `effectName`, or null if the bundle doesn't export one
     *  for this ID (the engine still relies on the numeric ID). */
    name: string | null
    /** Free-form descriptor: which engine handler / table claims this ID. */
    handler: string
}

export const LEGACY_EFFECT_IDS: ReadonlyArray<LegacyEffectEntry> = [
    // Active repair amount lookup (derived/tank.ts REPAIR_EFFECT_AMOUNT_ATTR).
    // SDE marks the effect as having empty modifierInfo because the actual
    // repair amount is read directly from a fixed attribute per layer
    // (shieldBonus 68 / armorDamageAmount 84 / structureDamageAmount 83).
    { id: 4,    name: null, handler: 'derived/tank::SHIELD_BOOSTING (active rep dispatch)' },
    { id: 26,   name: null, handler: 'derived/tank::HULL_REPAIR (structureRepair dispatch)' },
    { id: 27,   name: null, handler: 'derived/tank::ARMOR_REPAIR (active rep dispatch)' },
    // Cap booster activation (derived/capacitor.ts CAP_BOOSTER_EFFECT_ID).
    { id: 48,   name: null, handler: 'derived/capacitor::boosterDrainEntry' },
    // Drone damage skill (modifierEngine applyLegacyDroneDmgBonus).
    { id: 1730, name: null, handler: 'modifierEngine::applyLegacyDroneDmgBonus' },
    // T2 missile Specialization ROF skill (modifierEngine applyLegacyMissileSpecRof).
    { id: 1851, name: null, handler: 'modifierEngine::applyLegacyMissileSpecRof' },
    // Per-damage-type missile skill bonuses on the missile-class skills
    // (Rockets / Light Missiles / HAMs / Heavy Missiles / Cruise / Torpedo).
    // Each scales emDamage/explosiveDamage/kineticDamage/thermalDamage on
    // charges that require this skill, by `damageMultiplierBonus × level`.
    // Pyfa-parity: Effect660/661/662/668 are hardcoded handlers in eos
    // because the SDE modifierInfo is empty.
    { id: 660, name: null, handler: 'modifierEngine::applyLegacyMissileChargeDmg (em)' },
    { id: 661, name: null, handler: 'modifierEngine::applyLegacyMissileChargeDmg (explosive)' },
    { id: 662, name: null, handler: 'modifierEngine::applyLegacyMissileChargeDmg (thermal)' },
    { id: 668, name: null, handler: 'modifierEngine::applyLegacyMissileChargeDmg (kinetic)' },
    // HIC bubble (modifierEngine applyLegacyHicBubble).
    { id: 3380, name: null, handler: 'modifierEngine::applyLegacyHicBubble' },
    // T3C subsystem AddPassive HP / cap / cargo / sig.
    { id: 3771, name: null, handler: 'modifierEngine::applyLegacySubsystemAddPassive (armorHP)' },
    { id: 3808, name: null, handler: 'modifierEngine::applyLegacySubsystemAddPassive (signatureRadius)' },
    { id: 3810, name: null, handler: 'modifierEngine::applyLegacySubsystemAddPassive (capacity)' },
    { id: 3811, name: null, handler: 'modifierEngine::applyLegacySubsystemAddPassive (capacitorCapacity)' },
    { id: 3831, name: null, handler: 'modifierEngine::applyLegacySubsystemAddPassive (shieldCapacity)' },
    // Doomsday self-effects (legacy DD line).
    { id: 4489, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (legacy DD)' },
    { id: 4490, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (legacy DD)' },
    { id: 4491, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (legacy DD)' },
    { id: 4492, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (legacy DD)' },
    // Reactive Armor Hardener (modifierEngine applyLegacyRAH).
    { id: 4928, name: null, handler: 'modifierEngine::applyLegacyRAH' },
    // Ancillary Shield Booster (derived/tank.ts repairs).
    { id: 4936, name: null, handler: 'derived/tank::SHIELD_BOOSTING_FUELED' },
    // MJD signature bloom (modifierEngine applyLegacyMjdSigBloom).
    { id: 4921, name: null, handler: 'modifierEngine::applyLegacyMjdSigBloom (Battleship MJD)' },
    // Ancillary Armor Repairer (derived/tank.ts repairs + Nanite Paste boost).
    { id: 5275, name: null, handler: 'derived/tank::ARMOR_REPAIR_FUELED' },
    // Entosis Link (modifierEngine applyLegacyEntosisLink).
    { id: 6063, name: null, handler: 'modifierEngine::applyLegacyEntosisLink' },
    // Cap warfare projection (modifierEngine PROJECTION_CAP_WARFARE_DEFS).
    { id: 6184, name: null, handler: 'modifierEngine::buildCapWarfareReport (REMOTE_CAP)' },
    { id: 6185, name: null, handler: 'modifierEngine::buildRemoteRepReport (HULL)' },
    { id: 6186, name: null, handler: 'modifierEngine::buildRemoteRepReport (SHIELD)' },
    { id: 6187, name: null, handler: 'modifierEngine::buildCapWarfareReport (NEUT)' },
    { id: 6188, name: null, handler: 'modifierEngine::buildRemoteRepReport (ARMOR)' },
    { id: 6197, name: null, handler: 'modifierEngine::buildCapWarfareReport (NOS)' },
    { id: 6201, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (Reaper slash)' },
    { id: 6208, name: null, handler: 'modifierEngine::applyLegacyMjdSigBloom (Cruiser MJD)' },
    { id: 6216, name: null, handler: 'modifierEngine::buildCapWarfareReport (Structure NEUT)' },
    // Projection EWAR (sensor damp / tracking disrupt / guidance disrupt /
    // target paint / web — PROJECTION_EWAR_DEFS).
    { id: 6422, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (sensor damp)' },
    { id: 6423, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (guidance disruptor)' },
    { id: 6424, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (tracking disruptor)' },
    { id: 6425, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (target painter)' },
    { id: 6426, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (web/grappler)' },
    { id: 6427, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (remote sensor booster, friendly)' },
    { id: 6428, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (remote tracking computer, friendly)' },
    // Fighter ability self-modifiers (modifierEngine applyLegacyFighterAbilities).
    { id: 6439, name: null, handler: 'modifierEngine::applyLegacyFighterAbilities (Evasive Maneuvers)' },
    { id: 6440, name: null, handler: 'modifierEngine::applyLegacyFighterAbilities (Afterburner)' },
    { id: 6441, name: null, handler: 'modifierEngine::applyLegacyFighterAbilities (MicroWarpDrive)' },
    // Fighter primary attacks — read directly via effectIDs.has() in
    // derived/offense::fighterContributionFor (own-fit DPS aggregation,
    // not a modifier dispatch). Squadron damage attrs (2227-2230 + 2226
    // for turret family, 2131-2134 + 2130 for missile family).
    { id: 6431, name: null, handler: 'derived/offense::fighterContributionFor (missile attack family)' },
    { id: 6465, name: null, handler: 'derived/offense::fighterContributionFor (turret attack family)' },
    // Fighter projection abilities (modifierEngine applyLegacyFighterProjection).
    // Web (6435) writes a maxVelocity affliction; neut (6434) emits a
    // ProjectedEffectReport. Scram (6436) and Tackle (6464) plug into
    // collectEffectStoppers — same MWD/MJD suppression as module scram.
    { id: 6434, name: null, handler: 'modifierEngine::applyLegacyFighterProjection (Energy Neutralizer)' },
    { id: 6435, name: null, handler: 'modifierEngine::applyLegacyFighterProjection (Stasis Webifier)' },
    { id: 6436, name: null, handler: 'modifierEngine::collectEffectStoppers (Warp Disruption — stops MWD/MJD)' },
    { id: 6464, name: null, handler: 'modifierEngine::collectEffectStoppers (Tackle — stops MWD/MJD)' },
    // ECM projection (PROJECTION_ECM_EFFECT_IDS).
    { id: 6470, name: null, handler: 'modifierEngine::buildEcmProjectionReport' },
    // Marauder Burst Projector AoE (PROJECTION_EWAR_DEFS).
    { id: 6476, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (AoE web)' },
    { id: 6477, name: null, handler: 'modifierEngine::buildCapWarfareReport (Burst Projector NEUT)' },
    { id: 6478, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (AoE paint)' },
    { id: 6479, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (AoE track)' },
    { id: 6481, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (AoE damp)' },
    // Doomsday family (active modules).
    { id: 6472, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (DD beam)' },
    { id: 6473, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (DD cone)' },
    { id: 6474, name: null, handler: 'modifierEngine::applyLegacyDoomsdaySelfEffects (DD HOG)' },
    // Capital Emergency Hull Energizer.
    { id: 6484, name: null, handler: 'modifierEngine::applyLegacyCapitalEhe' },
    // Ancillary Remote Reps (PROJECTION_REMOTE_REP_DEFS).
    { id: 6651, name: null, handler: 'modifierEngine::buildRemoteRepReport (Remote AAR)' },
    { id: 6652, name: null, handler: 'modifierEngine::buildRemoteRepReport (Remote ASB)' },
    // Bastion Module (modifierEngine applyLegacyBastion).
    { id: 6658, name: null, handler: 'modifierEngine::applyLegacyBastion' },
    // Standup structure variants of the projection EWAR family.
    { id: 6682, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (Standup web)' },
    { id: 6683, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (Standup paint)' },
    { id: 6684, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (Standup damp)' },
    { id: 6685, name: null, handler: 'modifierEngine::buildEcmProjectionReport (Standup ECM)' },
    { id: 6686, name: null, handler: 'modifierEngine::PROJECTION_EWAR_DEFS (Standup track / guidance)' },
    { id: 6714, name: null, handler: 'modifierEngine::buildEcmProjectionReport (ECM Burst)' },
    // AB / MWD activation (modifierEngine applyLegacyPropMods).
    { id: 6730, name: null, handler: 'modifierEngine::applyLegacyPropMods (MWD)' },
    { id: 6731, name: null, handler: 'modifierEngine::applyLegacyPropMods (AB)' },
    // Command burst family (modifierEngine applyLegacyCommandBursts).
    { id: 6732, name: null, handler: 'modifierEngine::applyLegacyCommandBursts' },
    { id: 6733, name: null, handler: 'modifierEngine::applyLegacyCommandBursts' },
    { id: 6734, name: null, handler: 'modifierEngine::applyLegacyCommandBursts' },
    { id: 6735, name: null, handler: 'modifierEngine::applyLegacyCommandBursts' },
    { id: 6736, name: null, handler: 'modifierEngine::applyLegacyCommandBursts' },
    // Triglavian disintegrator spool (modifierEngine applyLegacyDisintegratorSpool).
    { id: 6995, name: null, handler: 'modifierEngine::applyLegacyDisintegratorSpool' },
    // Mutadaptive RAR spool (modifierEngine applyLegacyMutadaptiveSpool).
    { id: 7166, name: null, handler: 'modifierEngine::applyLegacyMutadaptiveSpool' },
    // Vorton Projector chain — both ship-side (8037 ChainLightning) and
    // structure-side XL Standup Arcing Vorton (6447 lightningWeapon).
    // Both are classified via WEAPON_EFFECT_KIND and dispatched through
    // weaponContributionFor's chain logic (different per-effect attrs).
    { id: 8037, name: null, handler: 'derived/offense::Vorton ChainLightning (ship)' },
    { id: 6447, name: null, handler: 'derived/offense::Vorton ChainLightning (Standup XL)' },
    // System effect beacons (Incursion / Drifter Incursion / Triglavian /
    // wormhole class effects). Read by applyLegacySystemEffect when the
    // user picks a beacon type via the UI.
    { id: 4728, name: null, handler: 'modifierEngine::applyLegacySystemEffect' },
    // T3C subsystem slot/hardpoint markers. Empty modifierInfo because the
    // actual slot counts come from the subsystem's plain attrs (1368/1369/
    // 1374/1375/1376) which are read directly by applyLegacySubsystemSlots.
    // Marker effects exist on the subsystems to indicate "this subsystem
    // contributes slots/hardpoints to its parent ship" — semantically a
    // dispatch flag, no modifier math.
    { id: 3773, name: null, handler: 'modifierEngine::applyLegacySubsystemSlots (marker)' },
    { id: 3774, name: null, handler: 'modifierEngine::applyLegacySubsystemSlots (marker)' },
    // SCARAB Breacher Pod (derived/offense.ts breacherContributionFor).
    { id: 12174, name: null, handler: 'derived/offense::breacherContributionFor' },
    // Frigate MJD sig bloom.
    { id: 12126, name: null, handler: 'modifierEngine::applyLegacyMjdSigBloom (Frigate MJD)' },
] as const

// =============================================================================
// OUT_OF_SCOPE_EFFECT_IDS — effects that have empty modifierInfo AND no
// dedicated handler, but are deliberately NOT implemented because they don't
// affect the headline panel stats Pyfa shows (EHP / DPS / capacitor / nav /
// targeting). Documenting them here keeps the audit script honest: anyone
// asking "why isn't this fired?" gets the per-ID rationale instead of having
// to re-derive it from Pyfa source.
//
// Format mirrors LegacyEffectEntry but `handler` describes the rationale
// rather than the engine path. The audit script in `.test/effect-coverage-
// audit.ts` filters these out before reporting "truly silent" effects.
//
// Re-evaluate when:
//   - the headline panel grows a "mining yield" / "hacking strength" / "fleet
//     attack profile" surface (then the relevant effects move to LEGACY_EFFECT_IDS).
//   - fighter-as-projection-source plumbing lands (fighter projection abilities
//     6431/6434-6437/6442/6464/6465/6485/6554 leave this list).
// =============================================================================
export const OUT_OF_SCOPE_EFFECT_IDS: ReadonlyArray<LegacyEffectEntry> = [
    // ---- Hardpoint / slot dispatch markers consumed via fitChecks (not a modifier dispatch path). ----
    { id: 40,   name: null, handler: 'fitChecks::isMissileLauncher (hardpoint marker)' },
    { id: 42,   name: null, handler: 'fitChecks::isTurretWeapon (hardpoint marker, also on miners)' },
    { id: 263,  name: null, handler: 'fitChecks::reload-cycle marker (barrage)' },
    // ---- Targeting-only behaviours: do not modify ship stats ----
    { id: 54,   name: null, handler: 'OUT-OF-SCOPE :: targetPassively (passive lock, no stat impact)' },
    { id: 55,   name: null, handler: 'OUT-OF-SCOPE :: targetHostiles (target marker)' },
    { id: 46,   name: null, handler: 'OUT-OF-SCOPE :: shipScan (utility, no ship stat)' },
    { id: 47,   name: null, handler: 'OUT-OF-SCOPE :: cargoScan (utility, no ship stat)' },
    { id: 1738, name: null, handler: 'OUT-OF-SCOPE :: doHacking (data/relic analyzers, no stat impact)' },
    { id: 2255, name: null, handler: 'OUT-OF-SCOPE :: tractorBeamCan (utility)' },
    { id: 3793, name: null, handler: 'OUT-OF-SCOPE :: probeLaunching (utility)' },
    { id: 2757, name: null, handler: 'OUT-OF-SCOPE :: salvaging (utility)' },
    { id: 5163, name: null, handler: 'OUT-OF-SCOPE :: salvageDroneEffect (drone utility)' },
    { id: 8093, name: null, handler: 'OUT-OF-SCOPE :: cloneRespawnBay (no stat impact)' },
    { id: 8364, name: null, handler: 'OUT-OF-SCOPE :: industrialItemCompression (no stat impact)' },
    { id: 6719, name: null, handler: 'OUT-OF-SCOPE :: moduleBonusIndustrialInvulnerability (industrial-only state)' },
    { id: 848,  name: null, handler: 'OUT-OF-SCOPE :: cloakingTargetingDelayBonus (UI hint, no stat)' },
    { id: 2413, name: null, handler: 'OUT-OF-SCOPE :: snowBallLaunching (firework charges)' },
    { id: 103,  name: null, handler: 'OUT-OF-SCOPE :: defenderMissileLaunching (missile defender, no stat)' },
    { id: 127,  name: null, handler: 'OUT-OF-SCOPE :: torpedoLaunching (charge marker; launchers use 101/9)' },
    { id: 104,  name: null, handler: 'OUT-OF-SCOPE :: fofMissileLaunching (charge marker; launchers use 101)' },
    { id: 2971, name: null, handler: 'OUT-OF-SCOPE :: bombLaunching (bomb charge marker; launchers use 101)' },
    // ---- Mining yield (out-of-scope for headline EHP/DPS/cap parity) ----
    { id: 17,   name: null, handler: 'OUT-OF-SCOPE :: mining (yield only; reach back if mining UI lands)' },
    { id: 67,   name: null, handler: 'OUT-OF-SCOPE :: miningLaser (yield only)' },
    { id: 2726, name: null, handler: 'OUT-OF-SCOPE :: miningClouds (yield only)' },
    // ---- NPC entity-only effects (used by NPC ships/structures, not player-fittable). ----
    { id: 6687, name: null, handler: 'OUT-OF-SCOPE :: npcEntityRemoteArmorRepairer' },
    { id: 6688, name: null, handler: 'OUT-OF-SCOPE :: npcEntityRemoteShieldBooster' },
    { id: 6689, name: null, handler: 'OUT-OF-SCOPE :: npcEntityRemoteHullRepairer' },
    { id: 6690, name: null, handler: 'OUT-OF-SCOPE :: remoteWebifierEntity' },
    { id: 6691, name: null, handler: 'OUT-OF-SCOPE :: entityEnergyNeutralizerFalloff' },
    { id: 6692, name: null, handler: 'OUT-OF-SCOPE :: remoteTargetPaintEntity' },
    { id: 6693, name: null, handler: 'OUT-OF-SCOPE :: remoteSensorDampEntity' },
    { id: 6694, name: null, handler: 'OUT-OF-SCOPE :: npcEntityWeaponDisruptor' },
    { id: 6695, name: null, handler: 'OUT-OF-SCOPE :: entityECMFalloff' },
    // ---- Fighter ability projection markers still deferred ----
    // ECM (6437): fits the existing buildEcmProjectionReport shape but the
    // jam-strength attribute IDs (~2246/2247/2248) need cross-checking
    // against Pyfa for per-sensor-type strength split. Bombs (6485) and
    // Kamikaze (6554) emit transient damage on the receiver — needs a
    // "projected DPS report" surface that today's `derived.projected[]`
    // doesn't carry. MJD (6442) is a self-mod movement effect with no
    // projection meaning on the receiver.
    { id: 6437, name: null, handler: 'DEFERRED :: fighterAbilityECM (projection — needs jam-strength attr mapping)' },
    { id: 6442, name: null, handler: 'OUT-OF-SCOPE :: fighterAbilityMicroJumpDrive (self-mod movement, no projection)' },
    { id: 6485, name: null, handler: 'DEFERRED :: fighterAbilityLaunchBomb (projected damage — needs projected-DPS surface)' },
    { id: 6554, name: null, handler: 'DEFERRED :: fighterAbilityKamikaze (projected damage — needs projected-DPS surface)' },
    // ---- Doomsday / Lancer projection AOE markers (projection-only, no self-stats) ----
    { id: 6482, name: null, handler: 'OUT-OF-SCOPE :: doomsdayAOEBubble (projection)' },
    { id: 6513, name: null, handler: 'OUT-OF-SCOPE :: doomsdayAOEECM (projection)' },
    { id: 11691, name: null, handler: 'OUT-OF-SCOPE :: debuffLance (Lancer dread projection)' },
    // ---- Titan effect generator (projected fleet buff — NOT a self-stat). ----
    { id: 6753, name: null, handler: 'OUT-OF-SCOPE :: moduleTitanEffectGenerator (projection)' },
    // ---- Upwell-structure module effects with no impact on the headline panel. ----
    // Surfaced when categories 65/66 entered the bundle (2026-05-03).
    { id: 6443, name: null, handler: 'OUT-OF-SCOPE :: pointDefense (Standup anti-missile, projection-only)' },
    { id: 7120, name: null, handler: 'OUT-OF-SCOPE :: structureCynoJammerOnline (system-wide cyno suppression state, no fit-panel stat)' },
] as const

/** Verify every effect ID in LEGACY_EFFECT_IDS is still present in the
 *  loaded dataset. Returns an array of complaints (empty when clean) so
 *  callers can surface the result via console.warn / throw / log telemetry.
 *
 *  Two failure modes detected:
 *    - "missing": SDE no longer carries this effect ID — the handler will
 *      silently no-op (Fenris Creations either renamed or deleted). Investigate.
 *    - "name-mismatch": SDE still carries the ID but with a different name
 *      than registered. Probably a Fenris Creations rename — the engine still works,
 *      but the registry comment / handler description is stale.
 *
 *  Run at engine boot in dev mode (gate via `import.meta.dev`). Production
 *  callers can opt in by passing the dataset to `verifyLegacyEffectIds()`. */
export function verifyLegacyEffectIds(
    effects: ReadonlyMap<number, { effectName?: string }>,
): Array<{ id: number; kind: 'missing' | 'name-mismatch'; expected: string | null; actual: string | null }> {
    const complaints: Array<{ id: number; kind: 'missing' | 'name-mismatch'; expected: string | null; actual: string | null }> = []
    for (const entry of LEGACY_EFFECT_IDS) {
        const eff = effects.get(entry.id)
        if (!eff) {
            complaints.push({ id: entry.id, kind: 'missing', expected: entry.name, actual: null })
            continue
        }
        if (entry.name !== null && eff.effectName && eff.effectName !== entry.name) {
            complaints.push({ id: entry.id, kind: 'name-mismatch', expected: entry.name, actual: eff.effectName })
        }
    }
    return complaints
}
