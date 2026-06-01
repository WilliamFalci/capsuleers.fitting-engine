/**
 * Multi-format fit exporters: DNA, Multibuy, plain typeID list. EFT
 * already lives in [eft/format.ts](eft/format.ts).
 *
 *  - DNA: `shipID:moduleID;count::` — used by EVE's in-game chat links
 *    and several third-party tools. Format ends with `::`.
 *  - Multibuy: simple "name x count" list, suitable for pasting into
 *    EVE's market multi-buy window or a contract. Includes ship + every
 *    fitted item + cargo, deduplicated and aggregated.
 *  - Type-id list: a flat newline-separated typeID list for tooling.
 */

import type { Fit, FittingDataset } from './types'

/** EVE in-game DNA link format. */
export function formatDna(fit: Fit): string {
    const parts: string[] = [`${fit.shipTypeID}:`]
    const counts = new Map<number, number>()
    function bump(id: number, n: number = 1) {
        counts.set(id, (counts.get(id) ?? 0) + n)
    }
    for (const m of fit.modules) {
        bump(m.typeID)
        if (m.chargeTypeID) bump(m.chargeTypeID)
    }
    for (const d of fit.drones) bump(d.typeID, d.countTotal)
    for (const f of fit.fighters) bump(f.typeID, f.count)
    for (const c of fit.cargo) bump(c.typeID, c.count)
    for (const i of fit.implants) bump(i.typeID)
    for (const b of fit.boosters) bump(b.typeID)
    for (const s of fit.subsystems) bump(s.typeID)
    for (const [id, count] of counts) parts.push(`${id};${count}:`)
    return parts.join('') + ':'
}

/** "Name x count" list for multibuy / contracts. */
export function formatMultibuy(fit: Fit, dataset: FittingDataset): string {
    const counts = new Map<number, number>()
    function bump(id: number, n: number = 1) {
        counts.set(id, (counts.get(id) ?? 0) + n)
    }
    bump(fit.shipTypeID)
    for (const m of fit.modules) {
        bump(m.typeID)
        if (m.chargeTypeID) bump(m.chargeTypeID)
    }
    for (const d of fit.drones) bump(d.typeID, d.countTotal)
    for (const f of fit.fighters) bump(f.typeID, f.count)
    for (const c of fit.cargo) bump(c.typeID, c.count)
    for (const i of fit.implants) bump(i.typeID)
    for (const b of fit.boosters) bump(b.typeID)
    for (const s of fit.subsystems) bump(s.typeID)
    const lines: string[] = []
    for (const [id, count] of counts) {
        const name = dataset.getType(id)?.name ?? `Type ${id}`
        lines.push(`${name} x${count}`)
    }
    lines.sort()
    return lines.join('\n')
}

/** typeID-per-line list. */
export function formatTypeIds(fit: Fit): string {
    const ids = new Set<number>()
    ids.add(fit.shipTypeID)
    for (const m of fit.modules) { ids.add(m.typeID); if (m.chargeTypeID) ids.add(m.chargeTypeID) }
    for (const d of fit.drones) ids.add(d.typeID)
    for (const f of fit.fighters) ids.add(f.typeID)
    for (const c of fit.cargo) ids.add(c.typeID)
    for (const i of fit.implants) ids.add(i.typeID)
    for (const b of fit.boosters) ids.add(b.typeID)
    for (const s of fit.subsystems) ids.add(s.typeID)
    return Array.from(ids).sort((a, b) => a - b).join('\n')
}
