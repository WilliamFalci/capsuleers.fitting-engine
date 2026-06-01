/**
 * Upwell-structure metadata: service slots + fuel-block consumption.
 *
 * Computed only when the host typeID resolves to a category=65 type
 * (Astrahus / Raitaru / Fortizar / etc.). Ship fits skip this entirely
 * and the field is reported as null on `ComputedFit.derived.structure`.
 *
 * Pyfa parity:
 *   - `serviceSlotsMax` from the structure hull's attr 2056 (`serviceSlots`)
 *   - `serviceModuleFuelAmount` (attr 2109) is the per-hour fuel block
 *     cost of an ONLINE service module. We sum it across modules whose
 *     state is ONLINE / ACTIVE / OVERLOAD (OFFLINE modules are anchored
 *     but not contributing to fuel burn).
 *   - The `serviceModuleFuelOnlineAmount` (attr 2110) attribute is the
 *     one-time onlining cost (not surfaced in the headline panel).
 */

import type { FitContext } from '../fitContext'
import type { StructureMeta, StructureServiceModule } from '../types'

const STRUCTURE_CATEGORY_ID = 65
const ATTR_SERVICE_SLOTS = 2056
const ATTR_SERVICE_FUEL_PER_HOUR = 2109

export function computeStructureMeta(ctx: FitContext): StructureMeta | null {
    const host = ctx.dataset.getType(ctx.ship.typeID)
    if (!host) return null
    const hostGroup = ctx.dataset.groups.get(host.groupID)
    if (!hostGroup || hostGroup.categoryID !== STRUCTURE_CATEGORY_ID) return null

    const serviceSlotsMax = ctx.ship.getFinal(ATTR_SERVICE_SLOTS, 0)
    const services: StructureServiceModule[] = []
    let fuelBlocksPerHour = 0
    let serviceSlotsUsed = 0

    for (let i = 0; i < ctx.modules.length; i += 1) {
        const m = ctx.modules[i]!
        if (m.slotType() !== 'SERVICE') continue
        serviceSlotsUsed += 1
        const fuelPerHourBase = m.getFinal(ATTR_SERVICE_FUEL_PER_HOUR, 0)
        const consuming = m.state === 'ONLINE' || m.state === 'ACTIVE' || m.state === 'OVERLOAD'
        const fuelPerHour = consuming ? fuelPerHourBase : 0
        fuelBlocksPerHour += fuelPerHour
        const t = ctx.dataset.getType(m.typeID)
        services.push({
            moduleIndex: i,
            typeID: m.typeID,
            name: t?.name ?? `typeID ${m.typeID}`,
            state: m.state,
            fuelBlocksPerHour: fuelPerHour,
        })
    }

    return { serviceSlotsMax, serviceSlotsUsed, fuelBlocksPerHour, services }
}
