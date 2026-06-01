/**
 * EFT (EVE Fitting Tool) text format writer.
 *
 * Output layout matches the in-game export format and what every modern
 * fit tool produces:
 *
 *     [ShipName, FitName]
 *     <empty line>
 *     <Low slots>
 *     <empty line>
 *     <Mid slots>
 *     <empty line>
 *     <High slots, optional ", charge">
 *     <empty line>
 *     <Rigs>
 *     <empty line>
 *     <Subsystems>     (T3C only — section omitted otherwise)
 *     <empty line>
 *     <Drones x N>
 *     <empty line>
 *     <Implants / Boosters / Cargo x N>
 *
 * Empty sections are omitted entirely (no double blank lines). Implants and
 * boosters are rendered alongside cargo with quantity suffix per the
 * in-game export convention.
 *
 * Module ordering within a section follows the saved `position` field, then
 * id as tiebreaker. Stable ordering matters because EFT consumers expect the
 * same fit to round-trip identically.
 */

import type { Fit, FitModule, FittingDataset, SlotType } from '../types'

const SLOT_ORDER: readonly SlotType[] = ['LO', 'MED', 'HI', 'RIG']

export function formatEft(fit: Fit, dataset: FittingDataset): string {
    const ship = dataset.getType(fit.shipTypeID)
    if (!ship) {
        throw new Error(`format-eft: unknown ship typeID ${fit.shipTypeID}`)
    }
    const lines: string[] = []
    lines.push(`[${ship.name ?? `Type ${ship.id}`}, ${fit.name}]`)

    // Module sections, in EFT order: low → mid → high → rig.
    for (const slot of SLOT_ORDER) {
        const mods = fit.modules
            .filter(m => m.slotType === slot)
            .sort(byPosition)
        if (mods.length === 0) continue
        lines.push('')
        for (const m of mods) lines.push(formatModule(m, dataset))
    }

    // Subsystem section — only emit for T3C fits.
    if (fit.subsystems.length > 0) {
        const subs = [...fit.subsystems].sort((a, b) => a.slot - b.slot)
        lines.push('')
        for (const s of subs) {
            const t = dataset.getType(s.typeID)
            if (t) lines.push(t.name ?? `Type ${t.id}`)
        }
    }

    // Drones — count > 0 means in bay; we don't distinguish active in EFT.
    if (fit.drones.length > 0) {
        lines.push('')
        for (const d of fit.drones) {
            const t = dataset.getType(d.typeID)
            if (!t) continue
            lines.push(`${t.name ?? `Type ${t.id}`} x${d.countTotal}`)
        }
    }

    // Implants + boosters + cargo: combined list, each with " xN" suffix.
    const trailing: string[] = []
    for (const i of fit.implants) {
        const t = dataset.getType(i.typeID)
        if (t) trailing.push(`${t.name ?? `Type ${t.id}`} x1`)
    }
    for (const b of fit.boosters) {
        const t = dataset.getType(b.typeID)
        if (t) trailing.push(`${t.name ?? `Type ${t.id}`} x1`)
    }
    for (const c of fit.cargo) {
        const t = dataset.getType(c.typeID)
        if (t) trailing.push(`${t.name ?? `Type ${t.id}`} x${c.count}`)
    }
    if (trailing.length > 0) {
        lines.push('')
        for (const l of trailing) lines.push(l)
    }

    // Trailing newline so EFT consumers (which often expect a final \n
    // separator before EOF) don't mis-read the last entry.
    return lines.join('\n') + '\n'
}

function byPosition(a: FitModule, b: FitModule): number {
    return a.position - b.position || a.id.localeCompare(b.id)
}

function formatModule(m: FitModule, dataset: FittingDataset): string {
    const t = dataset.getType(m.typeID)
    const name = t?.name ?? `Type ${m.typeID}`
    if (m.chargeTypeID) {
        const ct = dataset.getType(m.chargeTypeID)
        if (ct?.name) return `${name}, ${ct.name}`
    }
    return name
}
