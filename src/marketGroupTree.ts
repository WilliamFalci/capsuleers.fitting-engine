/**
 * EVE Market-window taxonomy walker.
 *
 * The picker UIs render the same tree EVE shows in-game (Modules >
 * Capacitor Modules > Capacitor Battery, Modules > Hybrid Weapons >
 * Small Hybrid Turret, Drones > Combat Drones > Light Combat) by
 * walking each type's `marketGroupID` parent chain. Live engine
 * code never touches market groups — they're a pure presentation
 * concern routed through this helper.
 */

import type { FittingDataset, SdeType } from './types'

export interface MarketGroupPlacement {
    /** Stable category key for collapse/expand state persistence. */
    categoryKey: string
    /** Visible category label (top-level visible bucket in the picker). */
    categoryName: string
    /** Stable subgroup key — also feeds the deterministic hash used
     *  for open/close persistence within the picker. */
    subGroupKey: string
    /** Visible subgroup label (the leaf bucket directly containing
     *  the items). */
    subGroupName: string
}

/**
 * Map a type to a (category, subgroup) pair using the Market-window
 * tree.
 *
 *  - Walks `t.marketGroupID` up to the root via `parentGroupID`.
 *  - Subgroup = the leaf (closest to the item) — that's what
 *    in-game shows directly under each item.
 *  - Category = parent-of-leaf when the chain has ≥ 2 levels;
 *    otherwise the leaf itself (top-level Market entries like
 *    "Apparel" sit there).
 *  - Falls back to "Other / <SDE group name>" when the type carries
 *    no `marketGroupID` (skill books, system effects, …).
 */
export function marketGroupPlacement(t: SdeType, dataset: FittingDataset): MarketGroupPlacement {
    if (dataset.marketGroups.size === 0) {
        return sdeFallback(t, dataset)
    }
    const chain: Array<{ id: number; name?: string }> = []
    let cursor: number | undefined = t.marketGroupID
    const seen = new Set<number>()
    while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor)
        const node = dataset.marketGroups.get(cursor)
        if (!node) break
        chain.push({ id: node.id, name: node.name })
        cursor = node.parentGroupID
    }
    if (chain.length === 0) return sdeFallback(t, dataset)
    const leaf = chain[0]!
    const parent = chain[1] ?? leaf
    return {
        categoryKey: `mg-${parent.id}`,
        categoryName: parent.name ?? `Market group ${parent.id}`,
        subGroupKey: `mg-${leaf.id}`,
        subGroupName: leaf.name ?? `Market group ${leaf.id}`,
    }
}

function sdeFallback(t: SdeType, dataset: FittingDataset): MarketGroupPlacement {
    const groupRow = dataset.groups.get(t.groupID)
    return {
        categoryKey: 'cat-other',
        categoryName: 'Other',
        subGroupKey: `group-${t.groupID}`,
        subGroupName: groupRow?.name ?? `Group ${t.groupID}`,
    }
}
