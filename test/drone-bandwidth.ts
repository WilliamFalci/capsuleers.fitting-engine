/**
 * Drone bandwidth regression.
 *
 * Two bugs this pins down, both silent for as long as they existed:
 *
 *  1. `bandwidthUsed` read attribute **1271** (`droneBandwidth`) off the drone.
 *     1271 is the SHIP's cap — no drone carries it — so the lookup missed on
 *     every type, fell back to 0, and bandwidth used was ALWAYS 0. Drones carry
 *     **1272** (`droneBandwidthUsed`).
 *  2. `active` counted drone STACKS in space (`ctx.drones` holds one ItemState
 *     per FitDrone group), so five active Ogre IIs reported 1.
 *
 * Bandwidth is what decides how many drones actually fly — a Dominix carries
 * 375 m³ of drones but its 125 Mbit/s only passes five Ogre IIs — so both
 * numbers are load-bearing, not cosmetic.
 */
// Da `src/`, come la suite di parita': il gate di release gira PRIMA di
// `npm run build`, quindi un test che importa da `dist/` non trova nulla.
import { computeFit } from '../src/index'
import { buildAllVSkillProfile, loadBundledDataset } from '../src/node'
import type { Fit } from '../src/types'

const DOMINIX = 645, OGRE_II = 2446, HOBGOBLIN_II = 2456

const dataset = await loadBundledDataset()
const skillProfile = buildAllVSkillProfile(dataset)
const compute = (fit: Fit) => computeFit(fit, dataset, { skillProfile })

let fails = 0
const check = (label: string, ok: boolean, val: unknown) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${val}`)
    if (!ok) fails++
}

const baseFit = (drones: Fit['drones']): Fit => ({
    name: 'BW regression', shipTypeID: DOMINIX, visibility: 'PRIVATE', tags: [],
    modules: [], subsystems: [], fighters: [], cargo: [], implants: [], boosters: [], drones,
})

// The attributes the engine depends on, asserted against the bundle itself —
// so a future SDE reshuffle fails here rather than silently zeroing the stat.
const attr = (typeID: number, id: number) => dataset.getType(typeID)?.attributes.find(a => a.id === id)?.v
check('SDE: drone carries 1272, not 1271',
    attr(OGRE_II, 1272) === 25 && attr(OGRE_II, 1271) === undefined,
    `Ogre II 1272=${attr(OGRE_II, 1272)} 1271=${attr(OGRE_II, 1271)}`)
check('SDE: ship carries 1271, not 1272',
    attr(DOMINIX, 1271) === 125 && attr(DOMINIX, 1272) === undefined,
    `Dominix 1271=${attr(DOMINIX, 1271)} 1272=${attr(DOMINIX, 1272)}`)

// 5 Ogre II in space (25 Mbit/s each) exactly saturates a Dominix's 125.
{
    const { derived } = compute(baseFit([
        { id: 'd1', typeID: OGRE_II, countTotal: 5, countActive: 5 },
    ]))
    check('5 active Ogre II -> 125 Mbit/s used', derived.drones.bandwidthUsed === 125, derived.drones.bandwidthUsed)
    check('cap reported as 125', derived.drones.bandwidthMax === 125, derived.drones.bandwidthMax)
    check('active counts DRONES not stacks', derived.drones.active === 5, derived.drones.active)
    check('fitting mirror agrees', derived.fitting.droneBandwidthUsed === 125, derived.fitting.droneBandwidthUsed)
}

// Drones in the bay cost volume, not bandwidth: only countActive counts.
{
    const { derived } = compute(baseFit([
        { id: 'd1', typeID: OGRE_II, countTotal: 5, countActive: 2 },
        { id: 'd2', typeID: HOBGOBLIN_II, countTotal: 5, countActive: 0 },
    ]))
    check('idle drones burn no bandwidth', derived.drones.bandwidthUsed === 50, derived.drones.bandwidthUsed)
    check('bay counts the full stacks', derived.drones.bayUsed === 150, derived.drones.bayUsed)
    check('active = 2', derived.drones.active === 2, derived.drones.active)
}

// Mixed sizes, and over the cap — the case the UI must be able to flag.
{
    const { derived } = compute(baseFit([
        { id: 'd1', typeID: OGRE_II, countTotal: 5, countActive: 5 },
        { id: 'd2', typeID: HOBGOBLIN_II, countTotal: 5, countActive: 5 },
    ]))
    check('5 Ogre + 5 Hobgoblin -> 150 Mbit/s', derived.drones.bandwidthUsed === 150, derived.drones.bandwidthUsed)
    check('over the 125 cap', derived.drones.bandwidthUsed > derived.drones.bandwidthMax, `${derived.drones.bandwidthUsed} > ${derived.drones.bandwidthMax}`)
    check('active = 10', derived.drones.active === 10, derived.drones.active)
}

// No drones at all: zero, and no crash on a hull with no drone bay.
{
    const { derived } = compute(baseFit([]))
    check('no drones -> 0 used', derived.drones.bandwidthUsed === 0, derived.drones.bandwidthUsed)
    check('no drones -> 0 active', derived.drones.active === 0, derived.drones.active)
}

console.log(fails === 0 ? '\nOK — drone bandwidth' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
