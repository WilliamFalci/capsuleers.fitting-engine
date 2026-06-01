/**
 * EFT (EVE Fitting Tool) text format parser.
 *
 * EFT is the de-facto community-standard text format for sharing ship fits.
 * Pyfa, EFT, AFTER, in-game (after the export-to-clipboard feature), and
 * almost every fit tool can read/write it.
 *
 * Canonical structure:
 *
 *     [ShipName, FitName]
 *     <empty line>
 *     <Low slot module>
 *     <Low slot module>
 *     <empty line>
 *     <Mid slot module>
 *     <Mid slot module>
 *     <empty line>
 *     <Hi slot module>, <charge name>     ← optional ", <charge>" pairing
 *     <empty line>
 *     <Rig module>
 *     <empty line>                         ← optional Subsystem section (T3C only)
 *     <Subsystem module>
 *     <empty line>                         ← Drone bay
 *     <Drone name> x<count>
 *     <empty line>                         ← Implants/Boosters/Cargo (mixed)
 *     <Item name> x<count>
 *
 * Real-world EFT exports omit empty sections entirely (no trailing blank
 * lines), have inconsistent whitespace, occasionally include `[Empty Slot]`
 * placeholders, and sometimes interleave drones/cargo without a separator.
 * This parser is forgiving: it tolerates missing sections, extra blank
 * lines, mixed casing, and resolves names case-insensitively against the
 * dataset.
 *
 * Slot ordering convention (used by every modern tool):
 *   1. Low slots
 *   2. Mid slots
 *   3. High slots
 *   4. Rigs
 *   5. Subsystems (T3C only)
 *   6. Drones
 *   7. Cargo / Implants / Boosters (mixed, identified by category)
 *
 * In-game export reverses this (high → low). We accept both and disambiguate
 * by counting against the ship's slot attribute values when possible.
 */

import { CATEGORY, SLOT_EFFECT_TO_SLOT_TYPE } from '../constants'
import type {
    Fit,
    FitCargo,
    FitDrone,
    FitModule,
    FittingDataset,
    SdeType,
} from '../types'

export interface EftParseResult {
    fit: Fit
    /** Lines that couldn't be matched to anything in the SDE — surfaced to
     *  the UI as warnings (typo? renamed item? unsupported entry?). */
    warnings: Array<{ line: number; text: string; reason: string }>
}

interface NameIndex {
    /** Lower-cased name → typeID (latest-published wins on collision). */
    map: Map<string, number>
    types: Map<number, SdeType>
}

/**
 * Build a fast name-lookup index from the dataset. Caller is expected to
 * have loaded all type buckets that might appear in EFT input — typically
 * ships + modules + charges + drones + implants + subsystems + skills (for
 * implant detection — implants live in the implant bucket, but boosters
 * may also be there depending on SDE version).
 */
export function buildNameIndex(dataset: FittingDataset): NameIndex {
    const map = new Map<string, number>()
    const types = new Map<number, SdeType>()
    for (const bucket of Object.values(dataset.typesByBucket)) {
        if (!bucket) continue
        for (const t of bucket.values()) {
            types.set(t.id, t)
            if (t.name) map.set(t.name.toLowerCase(), t.id)
        }
    }
    return { map, types }
}

const HEADER_RE = /^\[(.+?),\s*(.+?)\]\s*$/
const QUANTITY_RE = /\sx(\d+)\s*$/i  // " x5" suffix on cargo / drones
const EMPTY_PLACEHOLDERS = new Set([
    '[empty low slot]',
    '[empty med slot]',
    '[empty high slot]',
    '[empty rig slot]',
    '[empty subsystem slot]',
])

/**
 * T3C subsystem groupID → fixed slot index. Mirrors the order rendered by
 * `SubsystemRow.vue` so the engine and the UI agree on which slot holds
 * which subsystem regardless of EFT line ordering.
 */
const SUBSYSTEM_GROUP_TO_SLOT: Record<number, number> = {
    954: 1, // Defensive
    956: 2, // Offensive
    957: 3, // Propulsion
    958: 4, // Core
}

/**
 * Parse an EFT-format string into a Fit object. The returned `fit.id` is
 * left undefined — the caller is responsible for assigning a uuid before
 * persisting to the database.
 *
 * The parser is intentionally tolerant: missing sections, extra blank
 * lines, charge with leading space, etc. Anything truly unparseable is
 * collected in `warnings` instead of throwing.
 */
export function parseEft(text: string, dataset: FittingDataset): EftParseResult {
    const lines = text.split(/\r?\n/)
    const warnings: Array<{ line: number; text: string; reason: string }> = []

    // Skip leading blank lines, find the header.
    let i = 0
    while (i < lines.length && lines[i]!.trim() === '') i++
    if (i >= lines.length) {
        throw new Error('EFT: empty input')
    }
    const headerLine = lines[i]!
    const headerMatch = HEADER_RE.exec(headerLine)
    if (!headerMatch) {
        throw new Error(`EFT: missing or malformed header on line ${i + 1}: ${headerLine.trim()}`)
    }
    i++

    const shipName = headerMatch[1]!.trim()
    const fitName = headerMatch[2]!.trim()

    const idx = buildNameIndex(dataset)
    const shipID = idx.map.get(shipName.toLowerCase())
    if (shipID === undefined) {
        throw new Error(`EFT: unknown ship "${shipName}"`)
    }
    const shipType = idx.types.get(shipID)!
    if (shipType.categoryID !== CATEGORY.SHIP) {
        throw new Error(`EFT: header ship "${shipName}" is not a Ship category type`)
    }

    // Group remaining non-empty lines into sections separated by blank lines.
    const sections: Array<{ lineNo: number; entries: Array<{ line: number; text: string }> }> = []
    let current: { lineNo: number; entries: Array<{ line: number; text: string }> } | null = null
    for (; i < lines.length; i++) {
        const raw = lines[i]!
        const trimmed = raw.trim()
        if (trimmed === '') {
            if (current && current.entries.length > 0) {
                sections.push(current)
                current = null
            }
            continue
        }
        if (!current) current = { lineNo: i + 1, entries: [] }
        current.entries.push({ line: i + 1, text: trimmed })
    }
    if (current && current.entries.length > 0) sections.push(current)

    // Classify each section by examining its first parseable entry.
    // Modules/charges/rigs/subsystems → category MODULE/SUBSYSTEM, slot effect
    //                                   determines slot type
    // Drones → category DRONE
    // Implants/Boosters → category IMPLANT (split by group later — boosters
    //                     live in groupID 303, implants in 738/739/...)
    // Cargo (anything else) → fall-through

    const fit: Fit = {
        shipTypeID: shipType.id,
        name: fitName,
        visibility: 'PRIVATE',
        tags: [],
        modules: [],
        drones: [],
        fighters: [],
        cargo: [],
        implants: [],
        boosters: [],
        subsystems: [],
    }

    // Counters for slot positions (filled by encounter order within each
    // module section). The parser doesn't try to enforce slot caps — that's
    // the engine's job at validation time.
    const slotCursor = { HI: 0, MED: 0, LO: 0, RIG: 0, SUBSYSTEM: 0, SERVICE: 0 }

    for (const section of sections) {
        const sectionKind = classifySection(section.entries, idx, dataset)
        for (const entry of section.entries) {
            try {
                consumeEntry(entry, sectionKind, fit, slotCursor, idx, dataset, warnings)
            } catch (err: any) {
                warnings.push({ line: entry.line, text: entry.text, reason: err?.message ?? String(err) })
            }
        }
    }

    return { fit, warnings }
}

type SectionKind = 'modules' | 'drones' | 'cargo'

function classifySection(
    entries: Array<{ line: number; text: string }>,
    idx: NameIndex,
    _dataset: FittingDataset,
): SectionKind {
    // Look at the first entry that resolves cleanly. If it carries an "x N"
    // suffix → drones or cargo. If it has no quantity → module (or charge-
    // paired module). If the resolved type is in DRONE category → drones.
    for (const e of entries) {
        const { name, quantity } = parseEntryName(e.text)
        const typeID = idx.map.get(name.toLowerCase())
        if (typeID === undefined) continue
        const t = idx.types.get(typeID)!
        if (t.categoryID === CATEGORY.DRONE) return 'drones'
        if (quantity !== null && t.categoryID === CATEGORY.MODULE) {
            // Charges in the cargo bay may show as "Caldari Navy Antimatter Charge L x100".
            return 'cargo'
        }
        if (quantity !== null) return 'cargo'
        // No quantity + a module type → module section
        if (t.categoryID === CATEGORY.MODULE
            || t.categoryID === CATEGORY.SUBSYSTEM
            || t.categoryID === CATEGORY.IMPLANT) {
            return 'modules'
        }
    }
    return 'cargo'  // fallback for unknown sections
}

function parseEntryName(text: string): { name: string; charge: string | null; quantity: number | null } {
    const m = QUANTITY_RE.exec(text)
    if (m) {
        return { name: text.slice(0, m.index).trim(), charge: null, quantity: Number(m[1]) }
    }
    // Module with optional charge: "Module Name, Charge Name"
    const commaIdx = text.indexOf(',')
    if (commaIdx >= 0) {
        return {
            name: text.slice(0, commaIdx).trim(),
            charge: text.slice(commaIdx + 1).trim() || null,
            quantity: null,
        }
    }
    return { name: text.trim(), charge: null, quantity: null }
}

function consumeEntry(
    entry: { line: number; text: string },
    sectionKind: SectionKind,
    fit: Fit,
    slotCursor: Record<'HI' | 'MED' | 'LO' | 'RIG' | 'SUBSYSTEM' | 'SERVICE', number>,
    idx: NameIndex,
    dataset: FittingDataset,
    warnings: Array<{ line: number; text: string; reason: string }>,
): void {
    const lower = entry.text.toLowerCase()
    if (EMPTY_PLACEHOLDERS.has(lower)) return  // skip explicit empty markers

    const { name, charge, quantity } = parseEntryName(entry.text)
    const typeID = idx.map.get(name.toLowerCase())
    if (typeID === undefined) {
        warnings.push({ line: entry.line, text: entry.text, reason: `unknown type "${name}"` })
        return
    }
    const type = idx.types.get(typeID)!

    if (sectionKind === 'drones' || (quantity !== null && type.categoryID === CATEGORY.DRONE)) {
        const drone: FitDrone = {
            id: tempId(),
            typeID,
            countTotal: quantity ?? 1,
            countActive: 0,  // EFT doesn't track active count; default all-bay
        }
        fit.drones.push(drone)
        return
    }

    if (sectionKind === 'cargo' || quantity !== null) {
        // Items with an explicit `xN` quantity suffix are ALWAYS cargo —
        // EFT exports list stored cargo (drugs, charges, filaments,
        // spare implants) with quantity. They are NOT actively fitted.
        // Pre-fix this branch auto-promoted any IMPLANT-category item
        // (boosters / hardwirings) to `fit.implants`, which made the
        // engine apply their bonuses (e.g. Pyrolancea Dose II → +X%
        // missile damage) and inflated DPS readings on imported fits.
        // Now we only push to cargo. If the user wants a hardwiring or
        // booster fitted, they add it via the implant/booster picker.
        const cargo: FitCargo = { id: tempId(), typeID, count: quantity ?? 1 }
        fit.cargo.push(cargo)
        return
    }

    // Module section: determine slot type from the type's effects.
    const slot = detectSlot(type, dataset)
    if (!slot) {
        warnings.push({ line: entry.line, text: entry.text, reason: `cannot determine slot for "${name}"` })
        return
    }

    let chargeTypeID: number | undefined
    if (charge) {
        const cid = idx.map.get(charge.toLowerCase())
        if (cid === undefined) {
            warnings.push({ line: entry.line, text: entry.text, reason: `unknown charge "${charge}"` })
        } else {
            chargeTypeID = cid
        }
    }

    if (slot === 'SUBSYSTEM') {
        // Subsystem slots are positional by groupID (matches SubsystemRow.vue):
        //   954 Defensive  → slot 1
        //   956 Offensive  → slot 2
        //   957 Propulsion → slot 3
        //   958 Core       → slot 4
        // EFT exports list subsystems in arbitrary order, so we cannot rely on
        // encounter order to derive the slot — derive it from the type's group.
        const subSlot = SUBSYSTEM_GROUP_TO_SLOT[type.groupID] ?? (slotCursor.SUBSYSTEM + 1)
        fit.subsystems.push({ id: tempId(), slot: subSlot, typeID })
        slotCursor.SUBSYSTEM++
        return
    }

    const fm: FitModule = {
        id: tempId(),
        slotType: slot,
        position: slotCursor[slot]++,
        typeID,
        state: 'ONLINE',
        chargeTypeID,
    }
    fit.modules.push(fm)
}

function detectSlot(type: SdeType, dataset: FittingDataset): FitModule['slotType'] | null {
    for (const e of type.effects) {
        const effect = dataset.effects.get(e.id)
        if (!effect) continue
        const slot = SLOT_EFFECT_TO_SLOT_TYPE[effect.id]
        if (slot) return slot
    }
    return null
}

let tempCounter = 0
function tempId(): string {
    // EFT-parsed fits don't have stable ids until persisted; the engine's
    // calc pipeline uses these as stable map keys within a single calc pass.
    return `tmp:${++tempCounter}:${Date.now().toString(36)}`
}
