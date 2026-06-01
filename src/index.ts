/**
 * eve-fit-engine — public surface.
 *
 * A Pyfa-parity EVE Online fitting calculation engine. Given a `Fit` and a
 * `FittingDataset`, `computeFit` returns the full derived stat block
 * (offense / defense / capacitor / navigation / targeting / fitting /
 * projected / structure).
 *
 * The dataset *loader* is intentionally NOT part of this package: consumers
 * inject a `FittingDataset` (see ./types) built however they like (HTTP fetch
 * in a browser, fs read on a server). This keeps the package free of any
 * environment coupling (no `fetch`, no `fs`, no `window`) and free of CCP's
 * SDE data — which ships separately under CCP's own licence, never GPL.
 *
 * Licence: GPL-3.0-or-later. This engine is a derivative of pyfa-org/Pyfa.
 */

// ---- Types (always safe to import — no runtime cost) ----
export type * from './types'

// ---- Runtime ----
export { computeFit, type ComputeFitOptions } from './engine'
export { parseEft, type EftParseResult, buildNameIndex } from './eft/parser'
export { formatEft } from './eft/format'
export { formatDna, formatMultibuy, formatTypeIds } from './export'

// ---- Lower-level (advanced consumers / tests) ----
export { ATTR, CATEGORY, SLOT_EFFECT_ID, SLOT_EFFECT_TO_SLOT_TYPE, OPERATION_BY_SDE_CODE, REQUIRED_SKILL_PAIRS, STACKING_PENALTY_K, ACTIVATION_EFFECT_ID, REPAIR_EFFECT_AMOUNT_ATTR, WEAPON_EFFECT_KIND, LEGACY_EFFECT_IDS, OUT_OF_SCOPE_EFFECT_IDS, verifyLegacyEffectIds, type WeaponEffectKind, type LegacyEffectEntry } from './constants'
export { ModifiedAttribute } from './modifiedAttribute'
export { ItemState, type ItemKind } from './itemState'
export { FitContext, moduleAcceptsCharge } from './fitContext'
export { applySkills, applySourceItem, applyOneModifier, disintegratorSpoolBonus, disintegratorCyclesToFullSpool, LEGACY_HANDLED_EFFECT_IDS } from './modifierEngine'
export { combineMultiplicative, combinePenalized, combineUnstacked } from './stacking'

// ---- Derived stats (computed by computeFit; exported for direct use too) ----
export { computeLayerEhp, computeTotalEhp, ehpUnderProfile, type LayerEhp, type DefenseLayerKind } from './derived/ehp'
export { computeCapacitor, peakRecharge, rechargeRateAt, type CapacitorReport } from './derived/capacitor'
export { computeTank, type TankRates } from './derived/tank'
export { computeOffense, type OffenseReport } from './derived/offense'
export { computeStructureMeta } from './derived/structure'
export { effectiveDps } from './derived/application'

// ---- Effect classification helpers ----
export { classifyWeapon, readDamageComponents, readCycleInfo, readRangeInfo } from './effects/weapon'
export { classifyEwar, ecmJamChance, combineJamChances, type EwarKind } from './effects/ewar'
export { marketGroupPlacement, type MarketGroupPlacement } from './marketGroupTree'
export { computeT3CVariantCode } from './t3cVariant'

// ---- Skill prerequisites ----
export { checkSkills, type SkillCheckResult, type SkillRequirement } from './skillCheck'

// ---- Damage / target profile presets ----
export { DAMAGE_PROFILE_PRESETS, TARGET_PROFILE_PRESETS } from './profiles'

// ---- Fit-restriction predicates (picker filtering + drop validation) ----
export {
    canFitModuleOnShip,
    typeFitsSlotType,
    isTurretWeapon,
    isMissileLauncher,
    isSmartBomb,
    shipGroupRestrictions,
    shipTypeRestrictions,
    freeHardpointsFor,
    freeFitGroupSlotsFor,
    maxGroupFittedFor,
    maxTypeFittedFor,
    chargeGroupsForModule,
    moduleAcceptsAnyCharge,
    moduleAcceptsChargeType,
    defaultStateForModule,
    isActivatableModule,
} from './fitChecks'
