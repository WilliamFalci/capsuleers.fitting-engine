/**
 * Skill prerequisite analysis. Walks every fitted item (modules, drones,
 * fighters, charges, implants, boosters, subsystems) and aggregates the
 * unmet skill requirements against the active SkillProfile.
 */

import { REQUIRED_SKILL_PAIRS } from './constants'
import type { Fit, FittingDataset, SkillProfile, SdeType } from './types'

export interface SkillRequirement {
    skillID: number
    skillName: string
    requiredLevel: number
    currentLevel: number
}

export interface SkillCheckResult {
    /** Items that can't be used because at least one required skill is below
     *  the level dictated by the SDE. */
    unmet: Array<{
        sourceTypeID: number
        sourceName: string
        sourceKind: 'module' | 'charge' | 'drone' | 'fighter' | 'implant' | 'booster' | 'subsystem'
        requirements: SkillRequirement[]
    }>
    /** All distinct skills required by anything in the fit, with the
     *  highest level demanded across the whole fit. */
    aggregated: Map<number, { skillName: string; requiredLevel: number; currentLevel: number }>
}

function readRequirements(t: SdeType): Array<{ skillID: number; level: number }> {
    const out: Array<{ skillID: number; level: number }> = []
    for (const [skillAttr, levelAttr] of REQUIRED_SKILL_PAIRS) {
        const skillID = t.attributes.find(a => a.id === skillAttr)?.v
        const level = t.attributes.find(a => a.id === levelAttr)?.v
        if (skillID && level && skillID > 0 && level > 0) {
            out.push({ skillID: Math.round(skillID), level: Math.round(level) })
        }
    }
    return out
}

export function checkSkills(
    fit: Fit,
    dataset: FittingDataset,
    profile: SkillProfile,
): SkillCheckResult {
    const skills = profile.skills ?? {}
    const unmet: SkillCheckResult['unmet'] = []
    const aggregated = new Map<number, { skillName: string; requiredLevel: number; currentLevel: number }>()

    function inspect(typeID: number, kind: SkillCheckResult['unmet'][number]['sourceKind']) {
        const t = dataset.getType(typeID)
        if (!t) return
        const reqs = readRequirements(t)
        if (reqs.length === 0) return
        const failures: SkillRequirement[] = []
        for (const r of reqs) {
            const skillType = dataset.getType(r.skillID)
            const skillName = skillType?.name ?? `Skill ${r.skillID}`
            const current = skills[r.skillID] ?? 0
            const agg = aggregated.get(r.skillID)
            if (!agg || agg.requiredLevel < r.level) {
                aggregated.set(r.skillID, {
                    skillName,
                    requiredLevel: r.level,
                    currentLevel: current,
                })
            }
            if (current < r.level) {
                failures.push({
                    skillID: r.skillID,
                    skillName,
                    requiredLevel: r.level,
                    currentLevel: current,
                })
            }
        }
        if (failures.length > 0) {
            unmet.push({
                sourceTypeID: typeID,
                sourceName: t.name ?? `Type ${typeID}`,
                sourceKind: kind,
                requirements: failures,
            })
        }
    }

    inspect(fit.shipTypeID, 'module')  // ship is treated as the "hull" check
    for (const m of fit.modules) {
        inspect(m.typeID, 'module')
        if (m.chargeTypeID) inspect(m.chargeTypeID, 'charge')
    }
    for (const d of fit.drones) inspect(d.typeID, 'drone')
    for (const f of fit.fighters) inspect(f.typeID, 'fighter')
    for (const i of fit.implants) inspect(i.typeID, 'implant')
    for (const b of fit.boosters) inspect(b.typeID, 'booster')
    for (const s of fit.subsystems) inspect(s.typeID, 'subsystem')

    return { unmet, aggregated }
}
