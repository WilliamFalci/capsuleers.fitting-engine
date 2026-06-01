/**
 * Runtime state of a single fittable item — ship, module, drone, fighter,
 * implant, booster, charge, subsystem, mode, character.
 *
 * Each item carries its own ModifiedAttribute map keyed by attributeID.
 * Base values come from the SDE typeDogma row; modifiers are added during
 * the calc pass via the modifier engine, then `compute()` is called once
 * the pass is complete.
 *
 * Module state matters: only modules that pass `appliesAtState()` contribute
 * effects to the fit (offline modules don't add CPU usage either). Charges
 * project their attributes into the parent module's `otherID` domain.
 */

import { ATTR, REQUIRED_SKILL_PAIRS, SLOT_EFFECT_TO_SLOT_TYPE } from './constants'

const MASS_ATTR_ID     = ATTR.MASS
const VOLUME_ATTR_ID   = 161  // volume — not exposed in ATTR enum
const CAPACITY_ATTR_ID = 38   // capacity / cargo bay
import { ModifiedAttribute } from './modifiedAttribute'
import type {
    FitBooster,
    FitDrone,
    FitFighter,
    FitImplant,
    FitModule,
    FitSubsystem,
    ModifierAffliction,
    ModuleState,
    SdeEffect,
    SdeType,
    SlotType,
} from './types'

export type ItemKind =
    | 'ship'
    | 'module'
    | 'drone'
    | 'fighter'
    | 'implant'
    | 'booster'
    | 'charge'
    | 'subsystem'
    | 'mode'
    | 'character'

export interface ItemStateInit {
    kind: ItemKind
    /** Stable identifier within the fit (uuid for fit_modules etc.; sentinel
     *  strings like "ship", "char" for the singletons). */
    id: string
    type: SdeType
    /** Module/drone-style runtime state. Defaults to ONLINE for items where
     *  state semantics don't apply (ship, char). */
    state?: ModuleState
    /** Charge loaded into a module (only meaningful for kind === 'module'). */
    charge?: ItemState
    /** Per-instance attribute overrides (mutaplasmid). */
    attributeOverrides?: Record<number, number>
}

export class ItemState {
    readonly kind: ItemKind
    readonly id: string
    readonly type: SdeType
    readonly typeID: number
    readonly groupID: number
    readonly categoryID: number
    state: ModuleState
    charge: ItemState | null
    /** Effect IDs the item carries, populated lazily on first access. */
    readonly effectIDs: ReadonlySet<number>

    readonly attrs = new Map<number, ModifiedAttribute>()

    constructor(init: ItemStateInit) {
        this.kind = init.kind
        this.id = init.id
        this.type = init.type
        this.typeID = init.type.id
        this.groupID = init.type.groupID
        this.categoryID = init.type.categoryID
        this.state = init.state ?? 'ONLINE'
        this.charge = init.charge ?? null

        // Populate base attribute map from the typeDogma. attributeOverrides
        // (mutaplasmid) supersede the SDE defaults for the listed IDs.
        for (const a of init.type.attributes) {
            const base = init.attributeOverrides?.[a.id] ?? a.v
            this.attrs.set(a.id, new ModifiedAttribute(a.id, base))
        }

        // Mass / volume / capacity are stored as top-level fields on the type
        // row in the SDE — they are NOT mirrored into typeDogma. Without this
        // back-fill, `getBase(ATTR.MASS)` returns undefined for ships and the
        // velocity / align-time / propulsion-boost calculations all collapse
        // (e.g. AB/MWD `boost = thrust/mass` saturates because mass falls
        // back to 1).
        if (!this.attrs.has(MASS_ATTR_ID) && init.type.mass !== undefined) {
            this.attrs.set(MASS_ATTR_ID, new ModifiedAttribute(MASS_ATTR_ID, init.type.mass))
        }
        if (!this.attrs.has(VOLUME_ATTR_ID) && init.type.volume !== undefined) {
            this.attrs.set(VOLUME_ATTR_ID, new ModifiedAttribute(VOLUME_ATTR_ID, init.type.volume))
        }
        if (!this.attrs.has(CAPACITY_ATTR_ID) && init.type.capacity !== undefined) {
            this.attrs.set(CAPACITY_ATTR_ID, new ModifiedAttribute(CAPACITY_ATTR_ID, init.type.capacity))
        }

        this.effectIDs = new Set(init.type.effects.map(e => e.id))
    }

    /**
     * Get-or-create the ModifiedAttribute for this id. Returning a fresh
     * default-valued instance lets modifiers target attributes that aren't
     * in the type's typeDogma row yet — e.g. a skill that adds CPU output
     * to a ship that has no base CPU output (rare but valid in EVE).
     */
    attr(id: number, defaultBase = 0): ModifiedAttribute {
        let ma = this.attrs.get(id)
        if (!ma) {
            ma = new ModifiedAttribute(id, defaultBase)
            this.attrs.set(id, ma)
        }
        return ma
    }

    /** Read-only base value; `undefined` if the type doesn't carry the attr. */
    getBase(id: number): number | undefined {
        return this.attrs.get(id)?.base
    }

    /** Whether this item's typeDogma actually carries the attribute. Use to
     *  distinguish "missing attr" from "attr present but final value is 0",
     *  since `getFinal` returns 0 for both. */
    hasAttr(id: number): boolean {
        return this.attrs.has(id)
    }

    /** Compute the current modified value (cached until next addAffliction). */
    getFinal(id: number, fallback = 0): number {
        const ma = this.attrs.get(id)
        if (!ma) return fallback
        return ma.compute()
    }

    /** `defaultBase` is the seed base value when the target attribute isn't
     *  in the item's typeDogma — needed for SDE attrs whose `defaultValue`
     *  is non-zero (e.g. `missileDamageMultiplier` defaults to 1; without
     *  this, a BCS PreMul affliction would compute 1.1 × 0 = 0 → zero
     *  missile DPS on charges that don't carry attr_212 explicitly). */
    addAffliction(attributeID: number, a: ModifierAffliction, defaultBase = 0): void {
        this.attr(attributeID, defaultBase).addAffliction(a)
    }

    /** Reset every attribute on this item — used for incremental recompute. */
    resetAttributes(): void {
        for (const ma of this.attrs.values()) ma.reset()
    }

    /** Snapshot all attributes — for UI rendering or debug breakdown. */
    snapshotAll(): Map<number, ReturnType<ModifiedAttribute['snapshot']>> {
        const out = new Map<number, ReturnType<ModifiedAttribute['snapshot']>>()
        for (const [id, ma] of this.attrs) {
            out.set(id, ma.snapshot())
        }
        return out
    }

    /** Iterator over (attributeID, ModifiedAttribute) — for the engine. */
    *attributesEntries(): IterableIterator<readonly [number, ModifiedAttribute]> {
        for (const entry of this.attrs.entries()) yield entry
    }

    /** Whether this item's effects are active at the current state. */
    appliesAtState(effect: SdeEffect): boolean {
        // Effect categories (per Pyfa / EVE community docs):
        //   0 = passive (always)
        //   1 = active (cycle)
        //   2 = target-attack (active, also represents weapon cycle)
        //   3 = area
        //   4 = online (passive when state >= ONLINE)
        //   5 = overload (only at OVERLOAD)
        //   6 = system (always)
        //   7 = (unused)
        switch (effect.effectCategoryID) {
            case 0:
            case 6:
                return true                         // always-on
            case 4:
                return this.state !== 'OFFLINE'     // requires power
            case 1:
            case 2:
            case 3:
                return this.state === 'ACTIVE' || this.state === 'OVERLOAD'
            case 5:
                return this.state === 'OVERLOAD'
            default:
                // Unknown category: be conservative and treat as ONLINE-gated.
                return this.state !== 'OFFLINE'
        }
    }

    /**
     * Determine the slot type of a module by inspecting its effects.
     * Returns null for non-module items (no slot-classifying effect).
     */
    slotType(): SlotType | null {
        for (const eid of this.effectIDs) {
            const slot = SLOT_EFFECT_TO_SLOT_TYPE[eid]
            if (slot) return slot
        }
        return null
    }

    /**
     * Required skills for using this item, derived from typeDogma's reserved
     * attribute IDs (REQUIRED_SKILL_N → skillTypeID, REQUIRED_SKILL_N_LEVEL
     * → minimum level). Used by the skill validator + by skill-source
     * modifier filtering.
     */
    requiredSkills(): Array<{ skillID: number; level: number }> {
        const out: Array<{ skillID: number; level: number }> = []
        for (const [skillIDAttr, levelAttr] of REQUIRED_SKILL_PAIRS) {
            const skillID = this.getBase(skillIDAttr)
            if (skillID && skillID > 0) {
                const level = this.getBase(levelAttr) ?? 1
                out.push({ skillID, level })
            }
        }
        return out
    }
}

// =============================================================================
// Factories — convert the persistent Fit* models into runtime ItemState
// instances. The engine consumes ItemState everywhere; the persistent model
// is a write-time concern only.
// =============================================================================

export function makeShipState(type: SdeType): ItemState {
    return new ItemState({ kind: 'ship', id: 'ship', type })
}

export function makeCharacterState(charType: SdeType): ItemState {
    return new ItemState({ kind: 'character', id: 'char', type: charType })
}

export function makeModuleState(fm: FitModule, type: SdeType, chargeType?: SdeType): ItemState {
    let charge: ItemState | undefined
    if (chargeType) {
        charge = new ItemState({ kind: 'charge', id: `${fm.id}:charge`, type: chargeType })
    }
    return new ItemState({
        kind: 'module',
        id: fm.id,
        type,
        state: fm.state,
        charge,
        attributeOverrides: fm.mutator?.attributes,
    })
}

export function makeDroneState(fd: FitDrone, type: SdeType): ItemState {
    return new ItemState({
        kind: 'drone',
        id: fd.id,
        type,
        // Active drones contribute, idle drones in the bay don't. We model
        // this by keeping ALL drones in the engine but filtering at apply
        // time using `countActive` from the parent FitDrone.
        state: fd.countActive > 0 ? 'ACTIVE' : 'OFFLINE',
    })
}

export function makeFighterState(ff: FitFighter, type: SdeType): ItemState {
    return new ItemState({
        kind: 'fighter',
        id: ff.id,
        type,
        state: ff.count > 0 ? 'ACTIVE' : 'OFFLINE',
    })
}

export function makeImplantState(fi: FitImplant, type: SdeType): ItemState {
    return new ItemState({ kind: 'implant', id: fi.id, type, state: 'ONLINE' })
}

export function makeBoosterState(fb: FitBooster, type: SdeType): ItemState {
    return new ItemState({ kind: 'booster', id: fb.id, type, state: 'ONLINE' })
}

export function makeSubsystemState(fs: FitSubsystem, type: SdeType): ItemState {
    return new ItemState({ kind: 'subsystem', id: fs.id, type, state: 'ONLINE' })
}

export function makeModeState(modeTypeID: number, type: SdeType): ItemState {
    return new ItemState({ kind: 'mode', id: `mode:${modeTypeID}`, type, state: 'ACTIVE' })
}

// Convenience: peek at the launcher/turret hardpoint count of a ship.
export function shipHardpoints(ship: ItemState): { turret: number; launcher: number } {
    return {
        turret: ship.getFinal(ATTR.TURRET_HARDPOINTS, 0),
        launcher: ship.getFinal(ATTR.LAUNCHER_HARDPOINTS, 0),
    }
}
