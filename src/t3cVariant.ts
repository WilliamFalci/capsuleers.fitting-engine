/**
 * T3 Cruiser visual-variant resolver for the EstamelGG/EVE_Model_Gallery.
 *
 * The repo ships per-subsystem-combination models named like
 * `<typeID>_<ShipName><dddd>_lite.glb`. Each digit is the 1..3 rank of
 * the subsystem fitted in that slot. The gallery's digit order is:
 *
 *   digit 1 = Core slot       (groupID 958)
 *   digit 2 = Defensive slot  (groupID 954)
 *   digit 3 = Offensive slot  (groupID 956)
 *   digit 4 = Propulsion slot (groupID 957)
 *
 * Within each slot the gallery's rank-1/2/3 ordering doesn't follow
 * typeID, marketGroupID or any other obvious sort key — it appears to be
 * the editor's hand-picked order from the gallery repo. We therefore
 * encode the mapping explicitly per subsystem typeID; unknown
 * subsystems return null so the loader falls back to the base hull.
 */

import type { FitSubsystem, FittingDataset } from './types'

const T3C_PARENT_SHIP_IDS: ReadonlySet<number> = new Set([29984, 29986, 29988, 29990])
const PARENT_SHIP_ATTR = 1380

/** Ordered groupIDs that determine digit position in the variant code.
 *  Mirrors the gallery's filename convention (Core → Defensive →
 *  Offensive → Propulsion). */
const T3C_GROUP_ORDER: ReadonlyArray<number> = [958, 954, 956, 957]

/**
 * Explicit subsystem typeID → rank (1..3) within its slot.
 *
 * Mappings are sourced from the gallery's filename convention. Currently
 * filled in for Legion (Amarr T3C); other races land here as the data
 * is verified visually.
 */
const SUBSYSTEM_RANK_BY_TYPE_ID = new Map<number, number>([
	// ---- Tengu (29984) ----
	// Core slot (groupID 958)
    [45626, 2], // Tengu Core - Augmented Graviton Reactor
    [45625, 3], // Tengu Core - Electronic Efficiency Gate
    [45627, 1], // Tengu Core - Obfuscation Manifold
    // Defensive slot (groupID 954)
    [45590, 2], // Tengu Defensive - Supplemental Screening
    [45589, 3], // Tengu Defensive - Covert Reconfiguration
    [45591, 1], // Tengu Defensive - Amplification Node
    // Offensive slot (groupID 956)
    [45603, 2], // Tengu Offensive - Support Processor
    [45602, 3], // Tengu Offensive - Magnetic Infusion Basin
    [45601, 1], // Tengu Offensive - Accelerated Ejection Bay
    // Propulsion slot (groupID 957)
    [45614, 1], // Tengu Propulsion - Chassis Optimization
    [45615, 3], // Tengu Propulsion - Fuel Catalyst
    [45613, 2], // Tengu Propulsion - Interdiction Nullifier

    // ---- Legion (29986) ----
    // Core slot (groupID 958)
    [45624, 1], // Legion Core - Energy Parasitic Complex
    [45622, 2], // Legion Core - Dissolution Sequencer
    [45623, 3], // Legion Core - Augmented Antimatter Reactor
    // Defensive slot (groupID 954)
    [45587, 1], // Legion Defensive - Augmented Plating
    [45586, 2], // Legion Defensive - Covert Reconfiguration
    [45588, 3], // Legion Defensive - Nanobot Injector
    // Offensive slot (groupID 956)
    [45600, 1], // Legion Offensive - Support Processor
    [45599, 2], // Legion Offensive - Assault Optimization
    [45598, 3], // Legion Offensive - Liquid Crystal Magnifiers
    // Propulsion slot (groupID 957)
    [45611, 1], // Legion Propulsion - Intercalated Nanofibers
    [45612, 2], // Legion Propulsion - Wake Limiter
    [45610, 3], // Legion Propulsion - Interdiction Nullifier

    // ---- Proteus (29988) ----
    // Core slot (groupID 958)
    [45629, 2], // Proteus Core - Augmented Fusion Reactor
	[45628, 3], // Proteus Core - Electronic Efficiency Gate
	[45630, 1], // Proteus Core - Friction Extension Processor
	// Defensive slot (groupID 954)
	[45593, 2], // Proteus Defensive - Augmented Plating
	[45592, 3], // Proteus Defensive - Covert Reconfiguration
	[45594, 1], // Proteus Defensive - Nanobot Injector
	// Offensive slot (groupID 956)
	[45605, 1], // Proteus Offensive - Drone Synthesis Projector
	[45604, 2], // Proteus Offensive - Hybrid Encoding Platform
	[45606, 3], // Proteus Offensive - Support Processor
	// Propulsion slot (groupID 957)
	[45617, 3], // Proteus Propulsion - Hyperspatial Optimization
	[45616, 1], // Proteus Propulsion - Interdiction Nullifier
	[45618, 2], // Proteus Propulsion - Localized Injectors

    // ---- Loki (29990) ----
    // Core slot (groupID 958)
	[45632, 1], // Loki Core - Augmented Nuclear Reactor
	[45631, 3], // Loki Core - Dissolution Sequencer
	[45633, 2], // Loki Core - Immobility Drivers
	// Defensive slot (groupID 954)
	[45597, 3], // Loki Defensive - Adaptive Defense Node
	[45596, 2], // Loki Defensive - Augmented Durability
	[45595, 1], // Loki Defensive - Covert Reconfiguration
	// Offensive slot (groupID 956)
	[45608, 3], // Loki Offensive - Launcher Efficiency Configuration
	[45607, 2], // Loki Offensive - Projectile Scoping Array
	[45609, 1], // Loki Offensive - Support Processor
	// Propulsion slot (groupID 957)
	[45620, 1], // Loki Propulsion - Intercalated Nanofibers
	[45619, 2], // Loki Propulsion - Interdiction Nullifier
	[45621, 3], // Loki Propulsion - Wake Limiter
])

function attrValue(t: { attributes: Array<{ id: number; v: number }> }, id: number): number | undefined {
    for (const a of t.attributes) if (a.id === id) return a.v
    return undefined
}

/** Returns the 4-digit variant code for a fully-fitted T3C, or null when
 *  the ship isn't a T3C, the dataset isn't ready, any subsystem slot is
 *  empty, or any fitted subsystem isn't in the explicit rank table (the
 *  gallery only ships verified combinations; an unknown rank would yield
 *  a wrong filename). */
export function computeT3CVariantCode(
    shipTypeID: number,
    subsystems: ReadonlyArray<FitSubsystem>,
    dataset: FittingDataset | null | undefined,
): string | null {
    if (!dataset) return null
    if (!T3C_PARENT_SHIP_IDS.has(shipTypeID)) return null
    if (subsystems.length < T3C_GROUP_ORDER.length) return null

    const subsBucket = dataset.typesByBucket.subsystems
    if (!subsBucket) return null

    // Pick the fitted subsystem for each group in display order.
    const fittedByGroup = new Map<number, number>()
    for (const fs of subsystems) {
        const t = subsBucket.get(fs.typeID)
        if (!t) return null
        if (attrValue(t, PARENT_SHIP_ATTR) !== shipTypeID) return null
        fittedByGroup.set(t.groupID, fs.typeID)
    }

    let code = ''
    for (const groupID of T3C_GROUP_ORDER) {
        const fittedTypeID = fittedByGroup.get(groupID)
        if (fittedTypeID == null) return null
        const rank = SUBSYSTEM_RANK_BY_TYPE_ID.get(fittedTypeID)
        if (rank == null || rank < 1 || rank > 9) return null
        code += String(rank)
    }
    return code.length === T3C_GROUP_ORDER.length ? code : null
}
