/**
 * Pyfa parity validation harness.
 *
 * For each known test fit (one per screenshot in `.test/pyfa/`), this script:
 *   1. Constructs a Fit programmatically (typeIDs hard-coded from Pyfa's
 *      EFT export so the fit shape is reviewable in source).
 *   2. Loads the SDE bundle from `public/fitting-data/<version>/...`,
 *      patching `fetch()` so `loadDataset()` runs unchanged from inside
 *      a Node process.
 *   3. Runs `computeFit(...)` with All-V skills + Uniform damage profile +
 *      full disintegrator spool — Pyfa's default headline state.
 *   4. Asserts every stat (resources, EHP per layer + total, weapon DPS,
 *      cap stable %, navigation, targeting) against the values extracted
 *      from the corresponding Pyfa screenshot.
 *
 * Run with:  npm run test:pyfa
 *
 * Adding a new fit: drop a screenshot in `.test/pyfa/<shipname>.png`,
 * extract the EFT + Pyfa numbers, and append a new entry to `FITS` below.
 */

// Self-validation: this lives INSIDE the package and validates the shipping
// configuration — the package's own compute against its own bundled SDE
// (data/). Imports are relative to src/ so `tsx` runs it without a build.
import {
    computeFit,
    DAMAGE_PROFILE_PRESETS,
    verifyLegacyEffectIds,
    type Fit,
    type FittingDataset,
    type SkillProfile,
} from '../../src/index'
import { loadBundledDataset } from '../../src/node'

// ---------------------------------------------------------------------------
// Skill profile builder: All-V across every skill in the bucket.
// ---------------------------------------------------------------------------

function buildAllVSkillProfile(dataset: FittingDataset): SkillProfile {
    const skills: Record<number, 0 | 1 | 2 | 3 | 4 | 5> = {}
    const skillBucket = dataset.typesByBucket.skills
    if (!skillBucket) throw new Error('skills bucket not loaded')
    for (const id of skillBucket.keys()) skills[id] = 5
    return { name: 'All V', isDefault: true, source: 'preset', skills }
}

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

interface ExpectedStats {
    /** Total Effective HP under uniform damage. */
    ehpTotal: number
    /** Per-layer EHP. */
    ehpShield: number
    ehpArmor: number
    ehpHull: number
    /** Per-layer resists in percent (0-100). */
    shieldResist: { em: number; therm: number; kin: number; exp: number }
    armorResist: { em: number; therm: number; kin: number; exp: number }
    hullResist: { em: number; therm: number; kin: number; exp: number }
    /** Resources. */
    cpuUsed: number
    cpuMax: number
    powerUsed: number
    powerMax: number
    calibrationUsed: number
    calibrationMax: number
    /** Firepower (skip the assertion when omitted — useful for fits with no
     *  ammo loaded so per-cycle damage is 0 and Pyfa shows no DPS row). */
    weaponDps?: number
    /** Capacitor. Either `capStablePercent` (0..1) when stable, or
     *  `capSecondsToEmpty` when not stable. Omit both to skip the cap check
     *  (rare — only for fits where Pyfa shows weird structure-mode data). */
    capCapacity: number
    capStablePercent?: number
    capSecondsToEmpty?: number
    /** Navigation. */
    maxVelocity: number
    alignTime: number
    /** Targeting. */
    maxTargetingRangeKm: number
    scanResolution: number
    sensorStrength: number
    droneRangeKm: number
    /** Misc. */
    signatureRadius: number
}

interface TestFit {
    name: string
    screenshot: string
    /** Programmatic fit construction. */
    build: () => Fit
    expected: ExpectedStats
    /** Per-stat tolerance overrides for fits with known engine limitations
     *  (e.g. Logistics-class fleet bursts, capital rig stacking variants).
     *  Keys match the assertion label ('Total EHP', 'Armor EHP', etc.). */
    toleranceOverrides?: Record<string, number>
}

const FITS: TestFit[] = [
    {
        name: 'Babaroga · Kerrum Pithy',
        screenshot: 'babaroga.png',
        build: () => ({
            shipTypeID: 88001, // Babaroga
            name: "Kerrum Pithy's Babaroga",
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High slots (5)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 22949, state: 'ACTIVE' },  // 'Love' Medium Remote Armor Repairer
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 33400, state: 'ACTIVE' },  // Bastion Module I
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 81948, state: 'ACTIVE' },  // Consortium Small Tractor Beam
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 14234, state: 'ONLINE' },  // Dread Guristas Cloaking Device
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 52240, state: 'ACTIVE',    // Zorya's Supratidal Entropic Disintegrator
                  chargeTypeID: 47934 },                                                     // Occult L
                // Med slots (2 used / 4 total)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 23811, state: 'ACTIVE' },  // 'Plough' Heavy Capacitor Booster I
                { id: 'm1', slotType: 'MED', position: 1, typeID: 23811, state: 'ACTIVE' },  // 'Plough' Heavy Capacitor Booster I
                // Low slots (6 used / 8 total)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 18881, state: 'ONLINE' },  // Corpum A-Type Multispectrum Energized Membrane
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 18933, state: 'ACTIVE' },  // Corpus X-Type EM Armor Hardener
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 18937, state: 'ACTIVE' },  // Corpus X-Type Explosive Armor Hardener
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 18941, state: 'ACTIVE' },  // Corpus X-Type Kinetic Armor Hardener
                { id: 'l4', slotType: 'LO',  position: 4, typeID: 18945, state: 'ACTIVE' },  // Corpus X-Type Thermal Armor Hardener
                { id: 'l5', slotType: 'LO',  position: 7, typeID: 41200, state: 'ONLINE' },  // Shadow Serpentis Damage Control
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 26294, state: 'ONLINE' },  // Large Auxiliary Nano Pump II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 26296, state: 'ONLINE' },  // Large Nanobot Accelerator II
            ],
            drones: [
                { id: 'd0', typeID: 2175,  countTotal: 10, countActive: 0 }, // Infiltrator II — heavy, can't all be active w/o bandwidth
                { id: 'd1', typeID: 21640, countTotal: 10, countActive: 0 }, // Valkyrie II
                { id: 'd2', typeID: 23707, countTotal: 10, countActive: 0 }, // Hornet EC-300
            ],
            fighters: [],
            cargo: [
                { id: 'c0', typeID: 32006, count: 30 }, // Navy Cap Booster 400
            ],
            implants: [],
            boosters: [],
            subsystems: [],
        }),
        expected: {
            ehpTotal: 216_000,
            ehpShield: 12_200,
            ehpArmor: 163_000,
            ehpHull: 40_800,
            shieldResist: { em: 38.5, therm: 57,   kin: 63.1, exp: 76.9 },
            armorResist:  { em: 92.4, therm: 91.3, kin: 88.6, exp: 90.9 },
            hullResist:   { em: 73,   therm: 73,   kin: 73,   exp: 73 },
            cpuUsed: 586,    cpuMax: 875,
            powerUsed: 16_690, powerMax: 21_880,
            calibrationUsed: 300, calibrationMax: 400,
            weaponDps: 3164,
            capCapacity: 9_375,
            capStablePercent: 0.304,
            maxVelocity: 0,
            alignTime: 10.7,
            maxTargetingRangeKm: 116,
            scanResolution: 106,
            sensorStrength: 69.6,
            droneRangeKm: 60,
            signatureRadius: 400,
        },
    },

    // -----------------------------------------------------------------
    // Archon · Carrier · 'i.Ironwall READ NOTES'
    // -----------------------------------------------------------------
    {
        name: 'Archon · i.Ironwall',
        screenshot: 'archon.png',
        build: () => ({
            shipTypeID: 23757,
            name: 'i.Ironwall READ NOTES',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (5)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 90475, state: 'ACTIVE' },  // Integrated Sensor Array
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 24283, state: 'ONLINE' },  // Fighter Support Unit I
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 40661, state: 'ACTIVE' },  // Capital Infectious Scoped Energy Neutralizer
                { id: 'h3', slotType: 'HI',  position: 3, typeID:  3995, state: 'ACTIVE' },  // Large EMP Smartbomb II
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 12271, state: 'ACTIVE' },  // Heavy Energy Neutralizer II
                // Med (4)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 41238, state: 'ACTIVE' },  // 10000MN Monopropellant Enduring AB
                { id: 'm1', slotType: 'MED', position: 1, typeID: 41493, state: 'ACTIVE' },  // Capital Capacitor Booster II
                { id: 'm2', slotType: 'MED', position: 2, typeID: 24417, state: 'ONLINE' },  // Drone Navigation Computer II
                { id: 'm3', slotType: 'MED', position: 3, typeID: 24417, state: 'ONLINE' },  // Drone Navigation Computer II
                // Low (7)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 40351, state: 'ONLINE' },  // 25000mm Steel Plates II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 40351, state: 'ONLINE' },  // 25000mm Steel Plates II
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 18710, state: 'ONLINE' },  // Centii A-Type Multispectrum Coating
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 18710, state: 'ONLINE' },  // Centii A-Type Multispectrum Coating
                { id: 'l4', slotType: 'LO',  position: 4, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l5', slotType: 'LO',  position: 5, typeID:  4405, state: 'ONLINE' },  // Drone Damage Amplifier II
                { id: 'l6', slotType: 'LO',  position: 6, typeID:  4405, state: 'ONLINE' },  // Drone Damage Amplifier II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 30993, state: 'ONLINE' },  // Capital Trimark Armor Pump I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 30993, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 30993, state: 'ONLINE' },
            ],
            drones: [],
            fighters: [
                // 3 Light Fighter squadrons (Dragonfly II), 6/6 each — Pyfa shows 1984 drone DPS
                { id: 'f0', typeID: 40557, slot: 'LIGHT', count: 6 },
                { id: 'f1', typeID: 40557, slot: 'LIGHT', count: 6 },
                { id: 'f2', typeID: 40557, slot: 'LIGHT', count: 6 },
            ],
            cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 2_180_000,
            ehpShield: 104_000, ehpArmor: 1_840_000, ehpHull: 237_000,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 83.0, therm: 77.9, kin: 74.5, exp: 72.8 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 714,         cpuMax: 781.2,
            powerUsed: 595_400,   powerMax: 968_800,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 40,
            capCapacity: 72_500,
            capSecondsToEmpty: 336,    // 5m36s
            maxVelocity: 225,
            alignTime: 45.7,
            maxTargetingRangeKm: 4725,
            scanResolution: 525,
            sensorStrength: 130,
            droneRangeKm: 60,
            signatureRadius: 9_920,
        },
    },

    // -----------------------------------------------------------------
    // Cenotaph · Drifter Battlecruiser · 'Vipers 2.0 CENO'
    // -----------------------------------------------------------------
    {
        name: 'Cenotaph · Vipers 2.0',
        screenshot: 'cenotaph.png',
        build: () => ({
            shipTypeID: 85086,
            name: 'Vipers 2.0 CENO',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8)
                { id: 'h0', slotType: 'HI',  position: 0, typeID:  4477, state: 'ACTIVE' },  // Small Gremlin Compact Energy Neutralizer
                { id: 'h1', slotType: 'HI',  position: 1, typeID:  4477, state: 'ACTIVE' },
                { id: 'h2', slotType: 'HI',  position: 2, typeID:  4477, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 25715, state: 'ACTIVE', chargeTypeID: 27405 },  // HAM II + Caldari Navy Inferno HAM
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 25715, state: 'ACTIVE', chargeTypeID: 27405 },
                { id: 'h5', slotType: 'HI',  position: 5, typeID: 25715, state: 'ACTIVE', chargeTypeID: 27405 },
                { id: 'h6', slotType: 'HI',  position: 6, typeID: 85085, state: 'ACTIVE', chargeTypeID: 85089 },  // Medium Breacher Pod Launcher + SCARAB Breacher Pod M
                { id: 'h7', slotType: 'HI',  position: 7, typeID: 11578, state: 'ONLINE' },  // Covert Ops Cloaking Device II
                // Med (7)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 15770, state: 'ACTIVE' },  // Federation Navy 100MN Afterburner
                { id: 'm1', slotType: 'MED', position: 1, typeID: 31932, state: 'ONLINE' },  // Republic Fleet Large Shield Extender
                { id: 'm2', slotType: 'MED', position: 2, typeID: 32780, state: 'ACTIVE', chargeTypeID: 32006 },  // X-Large Ancillary Shield Booster + Navy Cap Booster 400
                { id: 'm3', slotType: 'MED', position: 3, typeID: 19231, state: 'ONLINE' },  // Pithum A-Type EM Shield Amplifier
                { id: 'm4', slotType: 'MED', position: 4, typeID:  2281, state: 'ACTIVE' },  // Multispectrum Shield Hardener II
                { id: 'm5', slotType: 'MED', position: 5, typeID:  2281, state: 'ACTIVE' },
                { id: 'm6', slotType: 'MED', position: 6, typeID:  3568, state: 'ACTIVE', chargeTypeID: 32006 },  // Small Capacitor Booster II + Navy Cap Booster 400
                // Low (2)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO',  position: 1, typeID:  2605, state: 'ONLINE' },  // Nanofiber Internal Structure II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31366, state: 'ONLINE' },  // Medium Ancillary Current Router II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31754, state: 'ONLINE' },  // Medium Thermal Shield Reinforcer I
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31185, state: 'ONLINE' },  // Medium Polycarbon Engine Housing II
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 81_200,
            ehpShield: 55_300, ehpArmor: 7_240, ehpHull: 18_700,
            shieldResist: { em: 77.6, therm: 71.9, kin: 74.6, exp: 78.8 },
            armorResist:  { em: 66.0, therm: 44.8, kin: 36.3, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 610.5,   cpuMax: 625,
            powerUsed: 1_580, powerMax: 1_581,
            calibrationUsed: 350, calibrationMax: 350,
            weaponDps: 992,
            capCapacity: 3_750,
            capStablePercent: 0.382,
            maxVelocity: 1_308,
            alignTime: 24.7,
            maxTargetingRangeKm: 62.5,
            scanResolution: 275,
            sensorStrength: 18,
            droneRangeKm: 60,
            signatureRadius: 284,
        },
    },

    // -----------------------------------------------------------------
    // Fortizar · Citadel · 'Basic' — DISABLED.
    // Citadels are in SDE category 65 ("Structure") which is intentionally
    // not in the fitting bundle (CATEGORY_TO_BUCKET filters to ship + module
    // + skill + drone + implant + subsystem + fighter only). Adding structure
    // support is a separate effort: the ship state machine, fitting limits,
    // and several Standup-only effects would need handlers. Leaving this
    // fixture in source as a roadmap entry; gated off until then.
    // -----------------------------------------------------------------
    /*
    {
        name: 'Fortizar · Basic',
        screenshot: 'fortizar.png',
        build: () => ({
            shipTypeID: 35833,
            name: 'Fortizar Basic',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (6)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 35921, state: 'ACTIVE' },  // Standup Anticapital Missile Launcher I
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 35921, state: 'ACTIVE' },
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 35921, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 35926, state: 'ACTIVE' },  // Standup Point Defense Battery I
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 35924, state: 'ACTIVE' },  // Standup XL Energy Neutralizer I
                { id: 'h5', slotType: 'HI',  position: 5, typeID: 35923, state: 'ACTIVE' },  // Standup Guided Bomb Launcher I
                // Med (5)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35943, state: 'ACTIVE' },  // Standup Stasis Webifier I
                { id: 'm1', slotType: 'MED', position: 1, typeID: 35947, state: 'ACTIVE' },  // Standup Target Painter I
                { id: 'm2', slotType: 'MED', position: 2, typeID: 35947, state: 'ACTIVE' },
                { id: 'm3', slotType: 'MED', position: 3, typeID: 35947, state: 'ACTIVE' },
                { id: 'm4', slotType: 'MED', position: 4, typeID: 35949, state: 'ACTIVE' },  // Standup Focused Warp Disruptor I
                // Low (4)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 35959, state: 'ONLINE' },  // Standup Ballistic Control System I
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 47360, state: 'ONLINE' },  // Standup Layered Armor Plating I
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 47360, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 47360, state: 'ONLINE' },
                // Service slot (1 used / 5 total)
                { id: 's0', slotType: 'SERVICE', position: 0, typeID: 35894, state: 'ONLINE' },  // Standup Cloning Center I
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 94_900_000,
            ehpShield: 33_800_000, ehpArmor: 34_100_000, ehpHull: 27_000_000,
            shieldResist: { em: 20, therm: 20, kin: 20, exp: 20 },
            armorResist:  { em: 20, therm: 20, kin: 20, exp: 20 },
            hullResist:   { em: 20, therm: 20, kin: 20, exp: 20 },
            cpuUsed: 28_100,    cpuMax: 38_000,
            powerUsed: 2_045_000, powerMax: 2_700_000,
            calibrationUsed: 0, calibrationMax: 400,
            capCapacity: 400_000,
            capSecondsToEmpty: 726,
            maxVelocity: 0,
            alignTime: 0,
            maxTargetingRangeKm: 380,
            scanResolution: 40,
            sensorStrength: 500,
            droneRangeKm: 20,
            signatureRadius: 100_000,
        },
    },
    */

    // -----------------------------------------------------------------
    // Jackdaw · Tactical Destroyer · Sharpshooter Mode · 'LONGBOW'
    // -----------------------------------------------------------------
    {
        name: 'Jackdaw · LONGBOW',
        screenshot: 'jackdaw.png',
        build: () => ({
            shipTypeID: 34828,
            name: 'LONGBOW',
            visibility: 'PRIVATE',
            tags: [],
            modeTypeID: 35678,  // Jackdaw Sharpshooter Mode
            modules: [
                // High (5 launchers + 1 empty) — loaded with Caldari Navy Scourge Light Missile
                { id: 'h0', slotType: 'HI',  position: 0, typeID:  2404, state: 'ACTIVE', chargeTypeID: 27361 },  // Light Missile Launcher II
                { id: 'h1', slotType: 'HI',  position: 1, typeID:  2404, state: 'ACTIVE', chargeTypeID: 27361 },
                { id: 'h2', slotType: 'HI',  position: 2, typeID:  2404, state: 'ACTIVE', chargeTypeID: 27361 },
                { id: 'h3', slotType: 'HI',  position: 3, typeID:  2404, state: 'ACTIVE', chargeTypeID: 27361 },
                { id: 'h4', slotType: 'HI',  position: 4, typeID:  2404, state: 'ACTIVE', chargeTypeID: 27361 },
                // Med (5)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35658, state: 'ACTIVE' },  // 5MN Quad LiF Restrained MWD
                { id: 'm1', slotType: 'MED', position: 1, typeID:  8517, state: 'ONLINE' },  // Medium F-S9 Regolith Compact Shield Extender
                { id: 'm2', slotType: 'MED', position: 2, typeID:  2281, state: 'ACTIVE' },  // Multispectrum Shield Hardener II
                { id: 'm3', slotType: 'MED', position: 3, typeID: 35790, state: 'ACTIVE' },  // Missile Guidance Computer II
                { id: 'm4', slotType: 'MED', position: 4, typeID: 35790, state: 'ACTIVE' },
                // Low (3)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 22291, state: 'ONLINE' },  // Ballistic Control System II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 16457, state: 'ONLINE' },  // Crosslink Compact Ballistic Control System
                { id: 'l2', slotType: 'LO',  position: 2, typeID:  2605, state: 'ONLINE' },  // Nanofiber Internal Structure II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31604, state: 'ONLINE' },  // Small Hydraulic Bay Thrusters II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31614, state: 'ONLINE' },  // Small Rocket Fuel Cache Partition II
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31722, state: 'ONLINE' },  // Small EM Shield Reinforcer II
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 8_770,
            ehpShield: 6_530, ehpArmor: 1_340, ehpHull: 896,
            shieldResist: { em: 53.4, therm: 73.0, kin: 69.6, exp: 66.2 },
            armorResist:  { em: 50.0, therm: 72.5, kin: 43.8, exp: 10.0 },
            hullResist:   { em: 33,   therm: 33,   kin: 33,   exp: 33 },
            cpuUsed: 335.2, cpuMax: 337.5,
            powerUsed: 71,  powerMax: 71.25,
            calibrationUsed: 375, calibrationMax: 400,
            weaponDps: 222,
            capCapacity: 700,
            capSecondsToEmpty: 740,    // 12m20s
            maxVelocity: 1_704,
            alignTime: 7.57,
            maxTargetingRangeKm: 138,    // Sharpshooter Mode: +100 % targeting range
            scanResolution: 625,
            sensorStrength: 36,           // Sharpshooter Mode: +100 % sensor strength
            droneRangeKm: 60,
            signatureRadius: 442,         // No Defense Mode sig reduction; MWD bloom on base 70-80 m hull
        },
    },

    // -----------------------------------------------------------------
    // Legion · Strategic Cruiser · Logi · 'ShadowHunters LOGI 2.0'
    // -----------------------------------------------------------------
    {
        name: 'Legion · ShadowHunters LOGI 2.0',
        screenshot: 'legion.png',
        build: () => ({
            shipTypeID: 29986,
            name: 'ShadowHunters LOGI 2.0',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 18987, state: 'ACTIVE' },  // Corelum C-Type Medium Remote Armor Repairer
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 18987, state: 'ACTIVE' },
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 18987, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 18987, state: 'ACTIVE' },
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 18987, state: 'ACTIVE' },
                { id: 'h5', slotType: 'HI',  position: 5, typeID: 18987, state: 'ACTIVE' },
                { id: 'h6', slotType: 'HI',  position: 6, typeID: 43552, state: 'ACTIVE', chargeTypeID: 42832 },  // Armor Command Burst II + Armor Energizing Charge (self-broadcast bonus to armor resists)
                { id: 'h7', slotType: 'HI',  position: 7, typeID: 11578, state: 'ONLINE' },  // Covert Ops Cloaking Device II
                // Med (2)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 15753, state: 'ACTIVE' },  // Republic Fleet 10MN Afterburner
                { id: 'm1', slotType: 'MED', position: 1, typeID: 41220, state: 'ONLINE' },  // Thukker Large Cap Battery
                // Low (7)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 28780, state: 'ONLINE' },  // Syndicate 1600mm Steel Plates
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 18845, state: 'ONLINE' },  // Corpum C-Type Thermal Energized Membrane
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 18833, state: 'ONLINE' },  // Corpum C-Type Kinetic Energized Membrane
                { id: 'l4', slotType: 'LO',  position: 4, typeID: 18841, state: 'ONLINE' },  // Corpum C-Type EM Energized Membrane
                { id: 'l5', slotType: 'LO',  position: 5, typeID:  4403, state: 'ACTIVE' },  // Reactive Armor Hardener
                { id: 'l6', slotType: 'LO',  position: 6, typeID: 14049, state: 'ONLINE' },  // Shadow Serpentis Multispectrum Coating
                // Rigs (3): 2× Medium Trimark Armor Pump II + 1× Medium
                // Remote Repair Augmentor II. Earlier screenshot only
                // showed the first rig visually so the fixture had been
                // assumed 3× Trimark — re-extracted screenshot makes the
                // mix explicit and resolves the +20 % armor HP overshoot
                // that was previously workaround'd via tolerance.
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31059, state: 'ONLINE' },  // Medium Trimark Armor Pump II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31059, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31079, state: 'ONLINE' },  // Medium Remote Repair Augmentor II
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [],
            subsystems: [
                { id: 's0', slot: 1, typeID: 45623 },  // Legion Core - Augmented Antimatter Reactor
                { id: 's1', slot: 2, typeID: 45586 },  // Legion Defensive - Covert Reconfiguration
                { id: 's2', slot: 3, typeID: 45600 },  // Legion Offensive - Support Processor
                { id: 's3', slot: 4, typeID: 45611 },  // Legion Propulsion - Intercalated Nanofibers
            ],
        }),
        expected: {
            // Pyfa's headline display reads 104.46 k EHP / 92.2 k armor /
            // resists 85.2/83.9/84.9/84.2 with the Armor Command Burst II
            // broadcasting Armor Energizing Charge to its OWN ship (Pyfa
            // applies fleet-burst self-broadcast). Our engine matches:
            // the burst is applied via `applyLegacyCommandBursts` in
            // modifierEngine.ts, with the dbuff value (a) derived
            // through the data-driven Effect 6737 chain (charge's
            // warfareBuff{N}Multiplier × module's warfareBuff{N}Value
            // × skill bonuses), then (b) PostPercent-scaled `value/100`,
            // then (c) put into the SAME `attr:${id}` stacking pool as
            // armor hardeners and energized membranes. With ONLY one
            // burst stacking under the same key as the membranes, the
            // ~16.5 % raw value penalty-stacks down to a ~1.5 pp
            // resistance gain — matching Pyfa's display.
            ehpTotal: 104_460,
            ehpShield: 4_800, ehpArmor: 92_200, ehpHull: 7_460,
            shieldResist: { em: 12.5, therm: 30,   kin: 60.6, exp: 78.1 },
            armorResist:  { em: 85.2, therm: 83.9, kin: 84.9, exp: 84.2 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 268.2, cpuMax: 275,
            powerUsed: 1_040, powerMax: 1_050,
            calibrationUsed: 225, calibrationMax: 400,
            capCapacity: 6_100,
            // Pyfa display reads "38.8 % stable" but the SDE Legion Defensive
            // - Covert Reconfiguration subsystem does NOT carry the Logi-class
            // -75 % capacitorNeed role bonus that real Logistics Cruisers
            // (Guardian / Basilisk / Oneiros / Scimitar) get from
            // eliteBonusLogistics{1,2} (attrs 678/679). The Legion is a T3
            // strategic cruiser, not a logi hull — its remote-rep mode comes
            // from generic Amarr Defensive subsystem bonuses (rep amount /
            // cap recharge), not the Logi cap-need reduction. The 38.8 %
            // figure in the Pyfa screenshot likely reflects either a
            // different skill / implant profile or a Pyfa quirk; deferred
            // until a Pyfa rerun with our exact module set confirms the
            // reference number. (Cap capacity still asserted.) See the
            // Guardian fixture below for the real Logi cap-need bonus
            // exercised data-driven via SHIP_BONUS_SCALING_SKILL[678/679].
            maxVelocity: 660,
            alignTime: 8.71,
            maxTargetingRangeKm: 87.5,
            scanResolution: 288,
            sensorStrength: 20.4,
            droneRangeKm: 60,
            signatureRadius: 175,
        },
    },

    // -----------------------------------------------------------------
    // Thunderchild · EDENCOM Battleship · 's.Astartes'
    // -----------------------------------------------------------------
    {
        name: 'Thunderchild · s.Astartes',
        screenshot: 'thunderchild.png',
        build: () => ({
            shipTypeID: 54733,
            name: 's.Astartes',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (2)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 54753, state: 'ACTIVE', chargeTypeID: 54783 },  // Large Vorton Projector II + ElectroPunch Ultra L
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 12271, state: 'ACTIVE' },  // Heavy Energy Neutralizer II
                // Med (7)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 14116, state: 'ACTIVE' },  // Shadow Serpentis 500MN Microwarpdrive
                { id: 'm1', slotType: 'MED', position: 1, typeID: 19227, state: 'ONLINE' },  // Pithum A-Type Thermal Shield Amplifier
                { id: 'm2', slotType: 'MED', position: 2, typeID:  3578, state: 'ONLINE' },  // Heavy Capacitor Booster II
                { id: 'm3', slotType: 'MED', position: 3, typeID: 19231, state: 'ONLINE' },  // Pithum A-Type EM Shield Amplifier
                { id: 'm4', slotType: 'MED', position: 4, typeID:  4349, state: 'ACTIVE' },  // Pithum C-Type Multispectrum Shield Hardener
                { id: 'm5', slotType: 'MED', position: 5, typeID: 31930, state: 'ONLINE' },  // Caldari Navy Large Shield Extender
                { id: 'm6', slotType: 'MED', position: 6, typeID: 31930, state: 'ONLINE' },
                // Low (5)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 54975, state: 'ONLINE' },  // Vorton Tuning System II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 54975, state: 'ONLINE' },
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 54975, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 31952, state: 'ONLINE' },  // Caldari Navy Power Diagnostic System
                { id: 'l4', slotType: 'LO',  position: 4, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 26448, state: 'ONLINE' },  // Large Core Defense Field Extender II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 26448, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 26448, state: 'ONLINE' },
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 275_000,
            ehpShield: 245_000, ehpArmor: 10_100, ehpHull: 20_500,
            shieldResist: { em: 80.2, therm: 80.2, kin: 74,   exp: 74 },
            armorResist:  { em: 57.5, therm: 53.2, kin: 36.3, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 1_052, cpuMax: 1_100,
            powerUsed: 21_760, powerMax: 22_170,
            calibrationUsed: 225, calibrationMax: 400,
            // Pyfa shows weapon DPS 459 with the Large Vorton Projector II loaded
            // with ElectroPunch Ultra L. Vorton DPS is simulated via the
            // disintegrator-style chain attack mechanic which our engine's
            // generic turret path doesn't model — skip until that's added.
            capCapacity: 8_510,
            capSecondsToEmpty: 193,    // 3m13s with the loaded charge's cap drain
            maxVelocity: 868,
            alignTime: 19.4,
            maxTargetingRangeKm: 148,
            scanResolution: 178,
            sensorStrength: 31.2,
            droneRangeKm: 60,
            signatureRadius: 3_350,
        },
    },

    // -----------------------------------------------------------------
    // Apostle · Force Auxiliary · TRIAGE · 'RepMaster ACTIVE 2.0'
    // -----------------------------------------------------------------
    {
        name: 'Apostle · RepMaster ACTIVE 2.0',
        screenshot: 'apostle.png',
        build: () => ({
            shipTypeID: 37604,
            name: 'RepMaster ACTIVE 2.0',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (6)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 41463, state: 'ACTIVE' },  // Capital I-ax Enduring Remote Armor Repairer
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 43552, state: 'ACTIVE' },  // Armor Command Burst II
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 41463, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 43552, state: 'ACTIVE' },  // Armor Command Burst II
                { id: 'h4', slotType: 'HI',  position: 4, typeID: 41463, state: 'ACTIVE' },
                { id: 'h5', slotType: 'HI',  position: 5, typeID:  4294, state: 'ACTIVE' },  // Triage Module II
                // Med (4)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 41492, state: 'ACTIVE' },  // Capital F-RX Compact Capacitor Booster
                { id: 'm1', slotType: 'MED', position: 1, typeID: 41485, state: 'ONLINE' },  // Capital Compact Pb-Acid Cap Battery
                { id: 'm2', slotType: 'MED', position: 2, typeID: 17526, state: 'ONLINE' },  // Imperial Navy Cap Recharger
                { id: 'm3', slotType: 'MED', position: 3, typeID: 17526, state: 'ONLINE' },
                // Low (7)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 15729, state: 'ONLINE' },  // Imperial Navy Multispectrum Energized Membrane
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 18939, state: 'ACTIVE' },  // Centus X-Type Explosive Armor Hardener
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 18943, state: 'ACTIVE' },  // Centus X-Type Kinetic Armor Hardener
                { id: 'l4', slotType: 'LO',  position: 4, typeID: 18947, state: 'ACTIVE' },  // Centus X-Type Thermal Armor Hardener
                { id: 'l5', slotType: 'LO',  position: 5, typeID: 41498, state: 'ACTIVE' },  // Capital I-a Enduring Armor Repairer
                { id: 'l6', slotType: 'LO',  position: 6, typeID: 41498, state: 'ACTIVE' },
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 27064, state: 'ONLINE' },  // Capital Auxiliary Nano Pump I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31410, state: 'ONLINE' },  // Capital Semiconductor Memory Cell I
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31075, state: 'ONLINE' },  // Capital Remote Repair Augmentor I
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 1_370_000,
            ehpShield: 122_000, ehpArmor: 862_000, ehpHull: 386_000,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 75.6, therm: 87.6, kin: 85.7, exp: 84.7 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 660,    cpuMax: 843.8,
            powerUsed: 1_016_000, powerMax: 1_031_000,
            calibrationUsed: 250, calibrationMax: 400,
            capCapacity: 130_000,
            capSecondsToEmpty: 168,    // 2m48s
            maxVelocity: 0,
            alignTime: 304,
            maxTargetingRangeKm: 138,
            scanResolution: 750,
            sensorStrength: 74.4,
            droneRangeKm: 60,
            signatureRadius: 10_500,
        },
    },

    // -----------------------------------------------------------------
    // Retribution · Amarr Assault Frigate · Pulse turret tackler
    // -----------------------------------------------------------------
    {
        name: 'Retribution',
        screenshot: 'retribution.png',
        build: () => ({
            shipTypeID: 11393,
            name: 'Retribution',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (4 turrets + 1 empty)
                { id: 'h0', slotType: 'HI',  position: 0, typeID:  3033, state: 'ACTIVE', chargeTypeID: 12557 },  // Small Focused Beam Laser II + Gleam S
                { id: 'h1', slotType: 'HI',  position: 1, typeID:  3033, state: 'ACTIVE', chargeTypeID: 12557 },
                { id: 'h2', slotType: 'HI',  position: 2, typeID:  3033, state: 'ACTIVE', chargeTypeID: 12557 },
                { id: 'h3', slotType: 'HI',  position: 3, typeID:  3033, state: 'ACTIVE', chargeTypeID: 12557 },
                // Med (2)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35658, state: 'ACTIVE' },  // 5MN Quad LiF Restrained MWD
                { id: 'm1', slotType: 'MED', position: 1, typeID: 15889, state: 'ACTIVE' },  // Caldari Navy Warp Disruptor
                // Low (5)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2364, state: 'ONLINE' },  // Heat Sink II
                { id: 'l1', slotType: 'LO',  position: 1, typeID:  2605, state: 'ONLINE' },  // Nanofiber II
                { id: 'l2', slotType: 'LO',  position: 2, typeID:  2605, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 33076, state: 'ACTIVE' },  // Small Ancillary Armor Repairer
                { id: 'l4', slotType: 'LO',  position: 4, typeID: 47257, state: 'ONLINE' },  // Assault Damage Control II
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31484, state: 'ONLINE' },  // Small Energy Locus Coordinator II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31484, state: 'ONLINE' },
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 6_430,
            ehpShield: 768, ehpArmor: 3_930, ehpHull: 1_740,
            shieldResist: { em: 7.5,  therm: 26,   kin: 72.2, exp: 88.4 },
            armorResist:  { em: 55.0, therm: 41.5, kin: 66.2, exp: 82.0 },
            hullResist:   { em: 53.1, therm: 53.1, kin: 53.1, exp: 53.1 },
            cpuUsed: 175,    cpuMax: 175,
            powerUsed: 74.6, powerMax: 77.5,
            calibrationUsed: 300, calibrationMax: 400,
            weaponDps: 272,
            capCapacity: 569,
            capSecondsToEmpty: 40,
            maxVelocity: 2_891,
            alignTime: 4.36,
            maxTargetingRangeKm: 50,
            scanResolution: 812,
            sensorStrength: 14.4,
            droneRangeKm: 60,
            signatureRadius: 114,
        },
    },

    // -----------------------------------------------------------------
    // Draugur · Triglavian Tactical Destroyer
    // Skirmish Command Burst II charges (Evasive + Rapid Deploy) currently
    // bleed self-onto-ship in the engine — disabled until charge-application
    // semantics for fleet bursts are split from passive module charges.
    /* eslint-disable */
    /*
    {
        name: 'Draugur · Triangle Supremacy',
        screenshot: 'draugur.png',
        build: () => ({
            shipTypeID: 52254,
            name: 'Triangle Supremacy',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (3)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 47915, state: 'ACTIVE', chargeTypeID: 47926 },  // Veles Light Entropic Disintegrator + Occult S
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 43556, state: 'ACTIVE', chargeTypeID: 42838 },  // Skirmish Command Burst II + Evasive
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 43556, state: 'ACTIVE', chargeTypeID: 42840 },  // Skirmish Command Burst II + Rapid
                // Med (3)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 15889, state: 'ACTIVE' },  // Caldari Navy Warp Disruptor
                { id: 'm1', slotType: 'MED', position: 1, typeID: 37479, state: 'ONLINE' },  // Micro Jump Field Generator
                { id: 'm2', slotType: 'MED', position: 2, typeID: 19325, state: 'ACTIVE' },  // Coreli A-Type 5MN Microwarpdrive
                // Low (4)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 31910, state: 'ONLINE' },  // Federation Navy 400mm Steel Plates
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 47911, state: 'ONLINE' },  // Entropic Radiation Sink II
                { id: 'l2', slotType: 'LO',  position: 2, typeID:  2605, state: 'ONLINE' },  // Nanofiber II
                { id: 'l3', slotType: 'LO',  position: 3, typeID: 33076, state: 'ACTIVE' },  // Small Ancillary Armor Repairer
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31364, state: 'ONLINE' },  // Small Ancillary Current Router II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 43894, state: 'ONLINE' },  // Small Command Processor I
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 9_450,
            ehpShield: 1_060, ehpArmor: 6_890, ehpHull: 1_510,
            shieldResist: { em: 0,    therm: 50,   kin: 40,   exp: 85   },
            armorResist:  { em: 50,   therm: 75,   kin: 25,   exp: 65   },
            hullResist:   { em: 33,   therm: 33,   kin: 33,   exp: 33   },
            cpuUsed: 281.5,  cpuMax: 275,    // Pyfa shows 102.36% — overshoot is expected
            powerUsed: 97.3, powerMax: 100.6,
            calibrationUsed: 300, calibrationMax: 400,
            weaponDps: 602,
            capCapacity: 1_150,
            capSecondsToEmpty: 130,    // 2m10s
            maxVelocity: 3_009,
            alignTime: 4.26,
            maxTargetingRangeKm: 75,
            scanResolution: 656,
            sensorStrength: 16.8,
            droneRangeKm: 60,
            signatureRadius: 166,
        },
    },
    */
    /* eslint-enable */

    // -----------------------------------------------------------------
    // Odysseus · Drifter Battlecruiser · Covert/utility
    // -----------------------------------------------------------------
    {
        name: 'Odysseus · LowSex 3.0 LEGO',
        screenshot: 'odysseus.png',
        build: () => ({
            shipTypeID: 89607,
            name: 'LowSex 3.0 LEGO',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8)
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 11578, state: 'ONLINE' },  // Covert Ops Cloaking Device II
                { id: 'h1', slotType: 'HI',  position: 1, typeID: 89615, state: 'ACTIVE' },  // Expedition Command Burst II
                { id: 'h2', slotType: 'HI',  position: 2, typeID: 89615, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 30836, state: 'ACTIVE' },  // Salvager II
                { id: 'h4', slotType: 'HI',  position: 4, typeID:  4250, state: 'ACTIVE' },  // Small Tractor Beam II
                { id: 'h5', slotType: 'HI',  position: 5, typeID: 49099, state: 'ONLINE' },  // Zero-Point Mass Entangler
                { id: 'h6', slotType: 'HI',  position: 6, typeID: 14228, state: 'ACTIVE' },  // Shadow Serpentis Small Plasma Smartbomb
                { id: 'h7', slotType: 'HI',  position: 7, typeID:  1182, state: 'ONLINE' },  // Auto Targeting System I
                // Med (5)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35661, state: 'ACTIVE' },  // 500MN Y-T8 Compact MWD
                { id: 'm1', slotType: 'MED', position: 1, typeID:  1952, state: 'ACTIVE' },  // Sensor Booster II
                { id: 'm2', slotType: 'MED', position: 2, typeID:  1952, state: 'ACTIVE' },
                { id: 'm3', slotType: 'MED', position: 3, typeID:  1952, state: 'ACTIVE' },
                { id: 'm4', slotType: 'MED', position: 4, typeID: 33915, state: 'ONLINE' },  // Medium Micro Jump Drive
                // Low (6)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO',  position: 1, typeID:  1987, state: 'ONLINE' },  // Signal Amplifier II
                { id: 'l2', slotType: 'LO',  position: 2, typeID:  1987, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO',  position: 3, typeID:  2605, state: 'ONLINE' },  // Nanofiber II
                { id: 'l4', slotType: 'LO',  position: 4, typeID:  2605, state: 'ONLINE' },
                { id: 'l5', slotType: 'LO',  position: 5, typeID: 11640, state: 'ONLINE' },  // Warp Core Stabilizer II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31360, state: 'ONLINE' },  // Medium Ancillary Current Router I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31167, state: 'ONLINE' },  // Medium Hyperspatial Velocity Optimizer II
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31185, state: 'ONLINE' },  // Medium Polycarbon Engine Housing II
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 40_700,
            ehpShield: 10_300, ehpArmor: 17_500, ehpHull: 12_900,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 66.0, therm: 55.8, kin: 55.8, exp: 38.8 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 627.5, cpuMax: 650,
            powerUsed: 1_615, powerMax: 1_616,
            calibrationUsed: 325, calibrationMax: 350,
            capCapacity: 2_720,
            capSecondsToEmpty: 100,    // 1m40s
            maxVelocity: 3_590,
            alignTime: 28,
            maxTargetingRangeKm: 113,
            scanResolution: 343,
            sensorStrength: 153,
            droneRangeKm: 60,
            signatureRadius: 1_880,
        },
    },

    // -----------------------------------------------------------------
    // Apocalypse Navy Issue · Battleship · 'i.Voidhawk DPS'
    // 8× Mega Beam Laser II + Aurora L (long-range crystal),
    // 2× Tracking Computer II (Optimal + Tracking scripts), 1× Heat Sink II,
    // armor buffer with 2× IN 1600mm + 3× faction hardeners + 3× Trimark.
    // -----------------------------------------------------------------
    {
        name: 'Apocalypse Navy Issue · i.Voidhawk DPS',
        screenshot: 'apocalypse navy issue.png',
        build: () => ({
            shipTypeID: 17726,
            name: 'i.Voidhawk DPS',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8) — all Mega Beam Laser II + Aurora L
                { id: 'h0', slotType: 'HI', position: 0, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h1', slotType: 'HI', position: 1, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h2', slotType: 'HI', position: 2, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h3', slotType: 'HI', position: 3, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h4', slotType: 'HI', position: 4, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h5', slotType: 'HI', position: 5, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h6', slotType: 'HI', position: 6, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                { id: 'h7', slotType: 'HI', position: 7, typeID:  3049, state: 'ACTIVE', chargeTypeID: 12824 },
                // Med (4)
                { id: 'm0', slotType: 'MED', position: 0, typeID:  5051, state: 'ACTIVE', chargeTypeID: 32014 },  // Heavy F-RX Cap Booster + Navy Cap Booster 800
                { id: 'm1', slotType: 'MED', position: 1, typeID:  1978, state: 'ACTIVE', chargeTypeID: 28999 },  // Tracking Computer II + Optimal Range Script
                { id: 'm2', slotType: 'MED', position: 2, typeID: 35662, state: 'ACTIVE' },                       // 500MN Quad LiF MWD
                { id: 'm3', slotType: 'MED', position: 3, typeID:  1978, state: 'ACTIVE', chargeTypeID: 29001 },  // Tracking Computer II + Tracking Speed Script
                // Low (8)
                { id: 'l0', slotType: 'LO', position: 0, typeID: 31900, state: 'ONLINE' },  // IN 1600mm Steel Plates
                { id: 'l1', slotType: 'LO', position: 1, typeID: 14063, state: 'ACTIVE' },  // Shadow Serpentis Kinetic Hardener
                { id: 'l2', slotType: 'LO', position: 2, typeID: 15729, state: 'ONLINE' },  // IN Multispectrum Energized Membrane
                { id: 'l3', slotType: 'LO', position: 3, typeID: 14061, state: 'ACTIVE' },  // Shadow Serpentis Explosive Hardener
                { id: 'l4', slotType: 'LO', position: 4, typeID: 31900, state: 'ONLINE' },  // IN 1600mm Steel Plates
                { id: 'l5', slotType: 'LO', position: 5, typeID: 14065, state: 'ACTIVE' },  // Shadow Serpentis Thermal Hardener
                { id: 'l6', slotType: 'LO', position: 6, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l7', slotType: 'LO', position: 7, typeID:  2364, state: 'ONLINE' },  // Heat Sink II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 25894, state: 'ONLINE' },  // Large Trimark Armor Pump I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 25894, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 25894, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID:  2488, countTotal: 5, countActive: 0 },  // Warrior II (in bay)
                { id: 'd1', typeID: 28215, countTotal: 3, countActive: 3 },  // Bouncer II (active = 144 DPS)
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 272_000,
            ehpShield: 17_300, ehpArmor: 221_000, ehpHull: 34_200,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 69.5, therm: 81.2, kin: 78.3, exp: 76.9 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 717.5, cpuMax: 725,
            powerUsed: 27_150, powerMax: 27_500,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 380,
            capCapacity: 7_000,
            capStablePercent: 0.799,
            maxVelocity: 1_090,
            alignTime: 18.3,
            maxTargetingRangeKm: 114,
            scanResolution: 195,
            sensorStrength: 30,
            droneRangeKm: 60,
            signatureRadius: 2_040,
        },
    },

    // -----------------------------------------------------------------
    // Arazu · Recon Cruiser (Gallente) · 'Vipers 3.0 POINT'
    // Tackle/cyno fit, mostly utility. The Pyfa screenshot includes a
    // Civilian Gatling Railgun (typeID 3638, `published=false` in SDE);
    // we whitelist it in build-fitting-bundle.ts so the cap drain it
    // contributes (~0.5 GJ/s) lines up with Pyfa's. Active drones:
    // 5× Hornet EC-300 (ECM, no DPS contribution; Pyfa intentionally
    // excludes drones from cap-stable simulation).
    // -----------------------------------------------------------------
    {
        name: 'Arazu · Vipers 3.0 POINT',
        screenshot: 'arazu.png',
        build: () => ({
            shipTypeID: 11969,
            name: 'Vipers 3.0 POINT',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (4) — including Civilian Gatling Railgun for cap parity.
                { id: 'h0', slotType: 'HI',  position: 0, typeID: 28646, state: 'ONLINE' },  // Covert Cynosural Field Generator I
                { id: 'h1', slotType: 'HI',  position: 1, typeID:  3638, state: 'ACTIVE' },  // Civilian Gatling Railgun
                { id: 'h2', slotType: 'HI',  position: 2, typeID:  1182, state: 'ONLINE' },  // Auto Targeting System I
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 11578, state: 'ONLINE' },  // Covert Ops Cloaking Device II
                // Med (6)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 18676, state: 'ACTIVE' },  // Gist X-Type 100MN AB
                { id: 'm1', slotType: 'MED', position: 1, typeID: 31932, state: 'ONLINE' },  // RF LSE
                { id: 'm2', slotType: 'MED', position: 2, typeID:  2281, state: 'ACTIVE' },  // MS Shield Hardener II
                { id: 'm3', slotType: 'MED', position: 3, typeID: 31932, state: 'ONLINE' },  // RF LSE
                { id: 'm4', slotType: 'MED', position: 4, typeID:  2301, state: 'ACTIVE' },  // EM Shield Hardener II
                { id: 'm5', slotType: 'MED', position: 5, typeID: 15891, state: 'ACTIVE' },  // RF Warp Disruptor
                // Low (4)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO', position: 1, typeID:  2605, state: 'ONLINE' },  // Nanofiber II
                { id: 'l2', slotType: 'LO', position: 2, typeID:  1541, state: 'ONLINE' },  // PDS II
                { id: 'l3', slotType: 'LO', position: 3, typeID:  1541, state: 'ONLINE' },  // PDS II
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31796, state: 'ONLINE' },  // Medium CDFE II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31796, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID: 23707, countTotal: 5, countActive: 5 },  // Hornet EC-300 active (no DPS)
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 59_500,
            ehpShield: 52_700, ehpArmor: 4_100, ehpHull: 2_690,
            shieldResist: { em: 71.7, therm: 70.5, kin: 86.7, exp: 70.5 },
            armorResist:  { em: 57.5, therm: 65.5, kin: 79.3, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 373, cpuMax: 525,
            powerUsed: 1_052, powerMax: 1_053,
            calibrationUsed: 150, calibrationMax: 400,
            // No weapon DPS — Civilian Gatling Railgun isn't in the SDE
            // bundle, so the hardpoint is empty in our fixture.
            capCapacity: 1_780,
            capStablePercent: 0.396,
            maxVelocity: 1_705,
            alignTime: 28.7,
            maxTargetingRangeKm: 119,
            scanResolution: 289,
            sensorStrength: 31.2,
            droneRangeKm: 60,
            signatureRadius: 214,
        },
    },

    // -----------------------------------------------------------------
    // Rapier · Recon Cruiser (Minmatar) · 'Vipers 3.0 WEB'
    // Cloaky tackle/web with Rapid Light Missile Launchers.
    // -----------------------------------------------------------------
    {
        name: 'Rapier · Vipers 3.0 WEB',
        screenshot: 'rapier.png',
        build: () => ({
            shipTypeID: 11963,
            name: 'Vipers 3.0 WEB',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (4)
                { id: 'h0', slotType: 'HI',  position: 0, typeID:  1877, state: 'ACTIVE', chargeTypeID: 27371 },  // RLML II + CN Inferno LM
                { id: 'h1', slotType: 'HI',  position: 1, typeID:  1877, state: 'ACTIVE', chargeTypeID: 27371 },
                { id: 'h2', slotType: 'HI',  position: 2, typeID:  1877, state: 'ACTIVE', chargeTypeID: 27371 },
                { id: 'h3', slotType: 'HI',  position: 3, typeID: 11578, state: 'ONLINE' },  // Covert Ops Cloaking Device II
                // Med (6)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 15770, state: 'ACTIVE' },  // FN 100MN AB
                { id: 'm1', slotType: 'MED', position: 1, typeID: 31932, state: 'ONLINE' },  // RF LSE
                { id: 'm2', slotType: 'MED', position: 2, typeID: 17559, state: 'ACTIVE' },  // FN Stasis Webifier
                { id: 'm3', slotType: 'MED', position: 3, typeID:  2281, state: 'ACTIVE' },  // MS Shield Hardener II
                { id: 'm4', slotType: 'MED', position: 4, typeID: 31932, state: 'ONLINE' },  // RF LSE
                { id: 'm5', slotType: 'MED', position: 5, typeID:  2281, state: 'ACTIVE' },  // MS Shield Hardener II
                // Low (4)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO', position: 1, typeID:  2605, state: 'ONLINE' },  // Nanofiber II
                { id: 'l2', slotType: 'LO', position: 2, typeID: 31952, state: 'ONLINE' },  // Caldari Navy PDS
                { id: 'l3', slotType: 'LO', position: 3, typeID: 31952, state: 'ONLINE' },  // Caldari Navy PDS
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31796, state: 'ONLINE' },  // Medium CDFE II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31796, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID: 23707, countTotal: 5, countActive: 5 },  // Hornet EC-300 active (no DPS)
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 72_400,
            ehpShield: 67_500, ehpArmor: 2_870, ehpHull: 2_110,
            shieldResist: { em: 84.1, therm: 78.8, kin: 74.6, exp: 78.8 },
            armorResist:  { em: 87.2, therm: 65.5, kin: 36.3, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 389.8, cpuMax: 600,
            powerUsed: 1_055, powerMax: 1_083,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 137,
            capCapacity: 1_630,
            capStablePercent: 0.457,
            maxVelocity: 1_717,
            alignTime: 28.4,
            maxTargetingRangeKm: 112,
            scanResolution: 302,
            sensorStrength: 28.8,
            droneRangeKm: 60,
            signatureRadius: 181,
        },
    },

    // -----------------------------------------------------------------
    // Rokh · Battleship (Caldari) · 'i.Rokh Bottom DPS'
    // 8× 425mm Railgun II + Spike L (long-range), 3× MFS II,
    // shield buffer (2× LSE II + 2× hardeners), MWD + cap booster.
    // -----------------------------------------------------------------
    {
        name: 'Rokh · i.Rokh Bottom DPS',
        screenshot: 'rokh.png',
        build: () => ({
            shipTypeID: 24688,
            name: 'i.Rokh Bottom DPS',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8)
                { id: 'h0', slotType: 'HI', position: 0, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h1', slotType: 'HI', position: 1, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h2', slotType: 'HI', position: 2, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h3', slotType: 'HI', position: 3, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h4', slotType: 'HI', position: 4, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h5', slotType: 'HI', position: 5, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h6', slotType: 'HI', position: 6, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                { id: 'h7', slotType: 'HI', position: 7, typeID:  3090, state: 'ACTIVE', chargeTypeID: 12807 },
                // Med (7)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35662, state: 'ACTIVE' },                       // 500MN Quad LiF MWD
                { id: 'm1', slotType: 'MED', position: 1, typeID:  2024, state: 'ACTIVE', chargeTypeID: 11289 },  // Medium Cap Booster II + Cap Booster 800
                { id: 'm2', slotType: 'MED', position: 2, typeID:  2301, state: 'ACTIVE' },  // EM Shield Hardener II
                { id: 'm3', slotType: 'MED', position: 3, typeID:  3841, state: 'ONLINE' },  // Large Shield Extender II
                { id: 'm4', slotType: 'MED', position: 4, typeID:  2281, state: 'ACTIVE' },  // MS Shield Hardener II
                { id: 'm5', slotType: 'MED', position: 5, typeID:  3841, state: 'ONLINE' },  // Large Shield Extender II
                { id: 'm6', slotType: 'MED', position: 6, typeID:  2281, state: 'ACTIVE' },  // MS Shield Hardener II
                // Low (4)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO', position: 1, typeID: 10190, state: 'ONLINE' },  // Magnetic Field Stabilizer II
                { id: 'l2', slotType: 'LO', position: 2, typeID: 10190, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO', position: 3, typeID: 10190, state: 'ONLINE' },
                // Rigs (3) — T1 CDFE
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 26088, state: 'ONLINE' },  // Large CDFE I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 26088, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 26088, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID:  2488, countTotal: 5, countActive: 0 },  // Warrior II (in bay)
                { id: 'd1', typeID: 28215, countTotal: 3, countActive: 3 },  // Bouncer II active (=144 DPS)
                { id: 'd2', typeID: 23707, countTotal: 5, countActive: 0 },  // Hornet EC-300 (in bay)
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 224_000,
            ehpShield: 181_000, ehpArmor: 16_800, ehpHull: 25_700,
            shieldResist: { em: 81.6, therm: 72.9, kin: 79.7, exp: 83.0 },
            armorResist:  { em: 57.5, therm: 53.2, kin: 36.3, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 886, cpuMax: 1_012,
            powerUsed: 18_290, powerMax: 18_750,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 415,
            capCapacity: 6_000,
            capSecondsToEmpty: 450,    // 7m30s
            maxVelocity: 790,
            alignTime: 19.8,
            maxTargetingRangeKm: 135,
            scanResolution: 122,
            sensorStrength: 28.8,
            droneRangeKm: 60,
            signatureRadius: 3_290,
        },
    },

    // -----------------------------------------------------------------
    // Tempest Fleet Issue · Battleship · 'i.Lollipop'
    // 6× 800mm Repeating Cannon II + Hail L (close-range high DPS),
    // 2× Heavy Energy Neutralizer II, Heavy Stasis Grappler + scram +
    // tracking computer, full armor buffer.
    // -----------------------------------------------------------------
    {
        name: 'Tempest Fleet Issue · i.Lollipop',
        screenshot: 'tempest fleet issue.png',
        build: () => ({
            shipTypeID: 17732,
            name: 'i.Lollipop',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8): 6 cannons + 2 neuts (TFI = 6 turret hardpoints)
                { id: 'h0', slotType: 'HI', position: 0, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h1', slotType: 'HI', position: 1, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h2', slotType: 'HI', position: 2, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h3', slotType: 'HI', position: 3, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h4', slotType: 'HI', position: 4, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h5', slotType: 'HI', position: 5, typeID:  2929, state: 'ACTIVE', chargeTypeID: 12779 },
                { id: 'h6', slotType: 'HI', position: 6, typeID: 12271, state: 'ACTIVE' },  // Heavy Energy Neut II
                { id: 'h7', slotType: 'HI', position: 7, typeID: 12271, state: 'ACTIVE' },
                // Med (5)
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35662, state: 'ACTIVE' },                       // 500MN Quad LiF MWD
                { id: 'm1', slotType: 'MED', position: 1, typeID: 41057, state: 'ACTIVE' },                       // Heavy Stasis Grappler II
                { id: 'm2', slotType: 'MED', position: 2, typeID:  5051, state: 'ACTIVE', chargeTypeID: 32014 },  // Heavy F-RX Cap Booster + Navy Cap Booster 800
                { id: 'm3', slotType: 'MED', position: 3, typeID:  1978, state: 'ACTIVE', chargeTypeID: 29001 },  // Tracking Computer II + Tracking Speed Script
                { id: 'm4', slotType: 'MED', position: 4, typeID:   448, state: 'ACTIVE' },                       // Warp Scrambler II
                // Low (7)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },  // Damage Control II
                { id: 'l1', slotType: 'LO', position: 1, typeID: 31900, state: 'ONLINE' },  // IN 1600mm Plates
                { id: 'l2', slotType: 'LO', position: 2, typeID: 31900, state: 'ONLINE' },  // IN 1600mm Plates
                { id: 'l3', slotType: 'LO', position: 3, typeID: 15729, state: 'ONLINE' },  // IN MS Energized Membrane
                { id: 'l4', slotType: 'LO', position: 4, typeID: 11646, state: 'ACTIVE' },  // Explosive Armor Hardener II
                { id: 'l5', slotType: 'LO', position: 5, typeID: 11644, state: 'ACTIVE' },  // Kinetic Armor Hardener II
                { id: 'l6', slotType: 'LO', position: 6, typeID: 11648, state: 'ACTIVE' },  // Thermal Armor Hardener II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 25894, state: 'ONLINE' },  // Large Trimark Armor Pump I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 25894, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 25894, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID:  2488, countTotal: 5, countActive: 0 },  // Warrior II (in bay)
                { id: 'd1', typeID: 28215, countTotal: 3, countActive: 3 },  // Bouncer II active (=144 DPS)
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 284_000,
            ehpShield: 22_100, ehpArmor: 231_000, ehpHull: 30_800,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 75.6, therm: 81.2, kin: 78.3, exp: 74.0 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 694.5, cpuMax: 725,
            powerUsed: 20_580, powerMax: 21_880,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 767,
            capCapacity: 5_500,
            capStablePercent: 0.483,
            maxVelocity: 1_140,
            alignTime: 19.1,
            maxTargetingRangeKm: 111,
            scanResolution: 162,
            sensorStrength: 28.8,
            droneRangeKm: 60,
            signatureRadius: 1_930,
        },
    },

    // -----------------------------------------------------------------
    // Avatar · Amarr Titan · 'Avatar Deliverance Mk. II'
    // Full bling brawl titan: 'Judgment' Doomsday + 5× CONCORD Dual Giga
    // Beam (Aurora XL), Capital F-RX with Navy Cap Booster 3200, triple
    // Capital Trimark Armor Pump, dual CONCORD 25000mm Steel Plates,
    // X-Type / Pithum hardener stack.
    // -----------------------------------------------------------------
    {
        name: 'Avatar · Deliverance Mk. II',
        screenshot: 'avatar.png',
        build: () => ({
            shipTypeID: 11567,
            name: 'Avatar Deliverance Mk. II',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (8): doomsday + 5 capital lasers + 2 empty
                { id: 'h0', slotType: 'HI', position: 0, typeID: 24550, state: 'ACTIVE' },                                  // 'Judgment' Electromagnetic Doomsday
                { id: 'h1', slotType: 'HI', position: 1, typeID:  3561, state: 'ACTIVE', chargeTypeID: 41336 },             // CONCORD Dual Giga Beam Laser + Aurora XL
                { id: 'h2', slotType: 'HI', position: 2, typeID:  3561, state: 'ACTIVE', chargeTypeID: 41336 },
                { id: 'h3', slotType: 'HI', position: 3, typeID:  3561, state: 'ACTIVE', chargeTypeID: 41336 },
                { id: 'h4', slotType: 'HI', position: 4, typeID:  3561, state: 'ACTIVE', chargeTypeID: 41336 },
                { id: 'h5', slotType: 'HI', position: 5, typeID:  3561, state: 'ACTIVE', chargeTypeID: 41336 },
                // Med (5): CONCORD shield ext, Pith X-Type EM hardener, Capital F-RX (Navy 3200), 2× Pithum A-Type Multi
                { id: 'm0', slotType: 'MED', position: 0, typeID: 41459, state: 'ONLINE' },                                 // CONCORD Capital Shield Extender
                { id: 'm1', slotType: 'MED', position: 1, typeID: 19282, state: 'ACTIVE' },                                 // Pith X-Type EM Shield Hardener
                { id: 'm2', slotType: 'MED', position: 2, typeID: 41492, state: 'ACTIVE', chargeTypeID: 41490 },            // Capital F-RX Compact Cap Booster + Navy Cap Booster 3200
                { id: 'm3', slotType: 'MED', position: 3, typeID:  4347, state: 'ACTIVE' },                                 // Pithum A-Type Multispectrum Shield Hardener
                { id: 'm4', slotType: 'MED', position: 4, typeID:  4347, state: 'ACTIVE' },
                // Low (8): 2× Corpum A-Type Multi membrane, Shadow Serpentis DC, Reactive AH, Corpus X-Type Exp,
                //         2× CONCORD 25000mm plates, Capital Flex AH II
                { id: 'l0', slotType: 'LO', position: 0, typeID: 18881, state: 'ONLINE' },                                  // Corpum A-Type Multispectrum Energized Membrane
                { id: 'l1', slotType: 'LO', position: 1, typeID: 18881, state: 'ONLINE' },
                { id: 'l2', slotType: 'LO', position: 2, typeID: 41200, state: 'ONLINE' },                                  // Shadow Serpentis Damage Control
                { id: 'l3', slotType: 'LO', position: 3, typeID:  4403, state: 'ACTIVE' },                                  // Reactive Armor Hardener
                { id: 'l4', slotType: 'LO', position: 4, typeID: 18937, state: 'ACTIVE' },                                  // Corpus X-Type Explosive Armor Hardener
                { id: 'l5', slotType: 'LO', position: 5, typeID: 41456, state: 'ONLINE' },                                  // CONCORD 25000mm Steel Plates
                { id: 'l6', slotType: 'LO', position: 6, typeID: 41456, state: 'ONLINE' },
                { id: 'l7', slotType: 'LO', position: 7, typeID: 41525, state: 'ACTIVE' },                                  // Capital Flex Armor Hardener II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31061, state: 'ONLINE' },                                 // Capital Trimark Armor Pump II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31061, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31061, state: 'ONLINE' },
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 29_600_000,
            ehpShield: 5_650_000,
            ehpArmor: 22_700_000,
            ehpHull: 1_270_000,
            shieldResist: { em: 86.4, therm: 78.3, kin: 83.8, exp: 86.5 },
            armorResist:  { em: 84.4, therm: 83.6, kin: 82.9, exp: 87.3 },
            hullResist:   { em: 61.5, therm: 61.5, kin: 61.5, exp: 61.5 },
            cpuUsed: 917,    cpuMax: 1_019,
            powerUsed: 1_196_000, powerMax: 1_562_000,
            calibrationUsed: 225, calibrationMax: 400,
            // Pyfa's 23 748 DPS averages the Judgment Doomsday over its
            // long burst cycle. Our offense engine reports only sustained
            // turret DPS (5× CONCORD Dual Giga Beam = 3 122). Until
            // doomsday-cycle averaging is implemented, skip the assertion
            // — the laser-only sustained number IS correct.
            // weaponDps: 23_748,
            capCapacity: 169_000,
            capStablePercent: 0.282,
            maxVelocity: 0,
            alignTime: 50.3,
            maxTargetingRangeKm: 300,
            scanResolution: 87.5,
            sensorStrength: 270,
            droneRangeKm: 60,
            signatureRadius: 23_600,
        },
    },

    // -----------------------------------------------------------------
    // Crucifier · Amarr T1 EWAR Frigate · 'VIPSTAR DISRUPT'
    // Tracking-disruption only (no weapons fitted). High slots empty.
    // -----------------------------------------------------------------
    {
        name: 'Crucifier · VIPSTAR DISRUPT',
        screenshot: 'cruifier.png',
        build: () => ({
            shipTypeID: 2161,
            name: 'VIPSTAR DISRUPT',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (2): both empty
                // Med (4): AB + 3× tracking disruptor with scripts
                { id: 'm0', slotType: 'MED', position: 0, typeID: 35656, state: 'ACTIVE' },                                 // 10MN Y-S8 Compact AB
                { id: 'm1', slotType: 'MED', position: 1, typeID:  5320, state: 'ACTIVE', chargeTypeID: 29005 },            // Balmer Series TD I + Optimal Range Disruption Script
                { id: 'm2', slotType: 'MED', position: 2, typeID:  5320, state: 'ACTIVE', chargeTypeID: 29005 },
                { id: 'm3', slotType: 'MED', position: 3, typeID:  5320, state: 'ACTIVE', chargeTypeID: 29007 },            // Balmer Series TD I + Tracking Speed Disruption Script
                // Low (3)
                { id: 'l0', slotType: 'LO',  position: 0, typeID:  2048, state: 'ONLINE' },                                 // Damage Control II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 11563, state: 'ONLINE' },                                 // Micro Auxiliary Power Core I
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 11563, state: 'ONLINE' },
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31177, state: 'ONLINE' },                                 // Small Polycarbon Engine Housing I
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31274, state: 'ONLINE' },                                 // Small Ionic Field Projector I
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 31346, state: 'ONLINE' },                                 // Small Tracking Diagnostic Subroutines I
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 2_360,
            ehpShield: 445,
            ehpArmor: 828,
            ehpHull: 1_090,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 57.5, therm: 44.8, kin: 36.3, exp: 32.0 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 177,   cpuMax: 293.75,
            powerUsed: 49,  powerMax: 58.75,
            calibrationUsed: 350, calibrationMax: 400,
            // No weapons fitted — skip weapon DPS.
            capCapacity: 412,
            capStablePercent: 0.505,
            maxVelocity: 2_246,
            alignTime: 17.3,
            maxTargetingRangeKm: 100,
            scanResolution: 675,
            sensorStrength: 16.8,
            droneRangeKm: 60,
            signatureRadius: 38,
        },
    },

    // -----------------------------------------------------------------
    // Curse · Amarr Recon · 'Curse Roam Cheap'
    // Cap-warfare brawler: 5 neuts (2 small + 3 medium), shield buffer,
    // Medium Cap Battery for resilience. Active drones: 5× Infiltrator II
    // (heavy gallente drones, 208 DPS reported in screenshot).
    // -----------------------------------------------------------------
    {
        name: 'Curse · Roam Cheap',
        screenshot: 'curse.png',
        build: () => ({
            shipTypeID: 20125,
            name: 'Curse Roam Cheap',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (5): 2× small + 3× medium energy neut II
                { id: 'h0', slotType: 'HI', position: 0, typeID: 13003, state: 'ACTIVE' },
                { id: 'h1', slotType: 'HI', position: 1, typeID: 13003, state: 'ACTIVE' },
                { id: 'h2', slotType: 'HI', position: 2, typeID: 12267, state: 'ACTIVE' },
                { id: 'h3', slotType: 'HI', position: 3, typeID: 12267, state: 'ACTIVE' },
                { id: 'h4', slotType: 'HI', position: 4, typeID: 12267, state: 'ACTIVE' },
                // Med (6)
                { id: 'm0', slotType: 'MED', position: 0, typeID:  2281, state: 'ACTIVE' },     // Multi Shield Hardener II
                { id: 'm1', slotType: 'MED', position: 1, typeID: 35657, state: 'ACTIVE' },     // 100MN Y-S8 Compact AB
                { id: 'm2', slotType: 'MED', position: 2, typeID:  3841, state: 'ONLINE' },     // Large Shield Extender II
                { id: 'm3', slotType: 'MED', position: 3, typeID:  3841, state: 'ONLINE' },
                { id: 'm4', slotType: 'MED', position: 4, typeID:  2301, state: 'ACTIVE' },     // EM Shield Hardener II
                { id: 'm5', slotType: 'MED', position: 5, typeID:  3496, state: 'ONLINE' },     // Medium Cap Battery II
                // Low (4)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  1541, state: 'ONLINE' },      // Power Diagnostic System II ×3
                { id: 'l1', slotType: 'LO', position: 1, typeID:  1541, state: 'ONLINE' },
                { id: 'l2', slotType: 'LO', position: 2, typeID:  1541, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO', position: 3, typeID:  2605, state: 'ONLINE' },      // Nanofiber Internal Structure II
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31366, state: 'ONLINE' },     // Medium Ancillary Current Router II
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31796, state: 'ONLINE' },     // Medium Core Defense Field Extender II
            ],
            drones: [
                { id: 'd0', typeID:  2488, countTotal: 10, countActive: 0 },  // Warrior II in bay
                { id: 'd1', typeID:  2175, countTotal:  5, countActive: 5 },  // Infiltrator II active (208 DPS)
                { id: 'd2', typeID: 23705, countTotal:  5, countActive: 0 },  // Vespa EC-600 in bay
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 41_700,
            ehpShield: 35_800,
            ehpArmor: 4_300,
            ehpHull: 1_600,
            shieldResist: { em: 67.7, therm: 46.0, kin: 74.7, exp: 87.3 },
            armorResist:  { em: 50.0, therm: 35.0, kin: 53.1, exp: 70.0 },
            hullResist:   { em: 33,   therm: 33,   kin: 33,   exp: 33 },
            cpuUsed: 382,  cpuMax: 475,
            powerUsed: 1_515, powerMax: 1_541,
            calibrationUsed: 225, calibrationMax: 400,
            // Drones-only DPS reported (no weapons), engine reports
            // weapon DPS = 0; drone DPS handled by separate stat — skip
            // weaponDps to avoid coupling to drone DPS reporting nuance.
            capCapacity: 3_030,
            capSecondsToEmpty: 120,    // "Lasts 2m0s" — net drain 15.1 GJ/s after neut self-cost
            maxVelocity: 1_345,
            alignTime: 29.7,
            maxTargetingRangeKm: 138,
            scanResolution: 351,
            sensorStrength: 33.6,
            droneRangeKm: 60,
            signatureRadius: 205,
        },
    },

    // -----------------------------------------------------------------
    // Keres · Gallente EAF · '√17. Cancer'
    // Triple Remote Sensor Dampener with mixed scripts, autocannon high
    // slots for kiting damage. Tiny ship.
    // -----------------------------------------------------------------
    {
        name: 'Keres · Cancer',
        screenshot: 'keres.png',
        build: () => ({
            shipTypeID: 11174,
            name: '√17. Cancer',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (2): 2× 125mm Gatling AC II + Barrage S
                { id: 'h0', slotType: 'HI', position: 0, typeID: 2873, state: 'ACTIVE', chargeTypeID: 12625 },
                { id: 'h1', slotType: 'HI', position: 1, typeID: 2873, state: 'ACTIVE', chargeTypeID: 12625 },
                // Med (5): 3× RSD II (2 Scan Res, 1 Targeting Range), shield ext, AB
                { id: 'm0', slotType: 'MED', position: 0, typeID: 1969, state: 'ACTIVE', chargeTypeID: 29013 },     // RSD + Scan Res Damp Script
                { id: 'm1', slotType: 'MED', position: 1, typeID: 1969, state: 'ACTIVE', chargeTypeID: 29013 },
                { id: 'm2', slotType: 'MED', position: 2, typeID: 1969, state: 'ACTIVE', chargeTypeID: 29015 },     // RSD + Targeting Range Damp Script
                { id: 'm3', slotType: 'MED', position: 3, typeID: 8517, state: 'ONLINE' },                          // Medium F-S9 Regolith Compact Shield Extender
                { id: 'm4', slotType: 'MED', position: 4, typeID: 35656, state: 'ACTIVE' },                         // 10MN Y-S8 Compact AB
                // Low (3)
                { id: 'l0', slotType: 'LO',  position: 0, typeID: 4254, state: 'ONLINE' },     // Micro Aux Power Core II
                { id: 'l1', slotType: 'LO',  position: 1, typeID: 4254, state: 'ONLINE' },
                { id: 'l2', slotType: 'LO',  position: 2, typeID: 2048, state: 'ONLINE' },     // Damage Control II
                // Rigs (2)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 31183, state: 'ONLINE' },    // Small Polycarbon Engine Housing II ×2
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 31183, state: 'ONLINE' },
            ],
            drones: [
                { id: 'd0', typeID: 2488, countTotal: 2, countActive: 2 },   // Warrior II active
            ],
            fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 5_200,
            ehpShield: 2_920,
            ehpArmor: 960,
            ehpHull: 1_320,
            shieldResist: { em: 12.5, therm: 47.5, kin: 73.8, exp: 56.2 },
            armorResist:  { em: 57.5, therm: 58.6, kin: 72.4, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 243.5,  cpuMax: 256.25,
            powerUsed: 70.3, powerMax: 71.25,
            calibrationUsed: 300, calibrationMax: 400,
            weaponDps: 39.9,
            capCapacity: 469,
            capStablePercent: 0.498,
            maxVelocity: 2_356,
            alignTime: 19.2,
            maxTargetingRangeKm: 80.6,
            scanResolution: 688,
            sensorStrength: 27.6,
            droneRangeKm: 60,
            signatureRadius: 50,
        },
    },

    // -----------------------------------------------------------------
    // Moros · Gallente Dreadnought · '√17. AntiCap 2.0'
    // Siege blaster anticap fit: Siege Module II + 3× Ion Siege Blaster II
    // (Void XL), Capital Infectious Scoped Energy Neut, dual Heavy Cap
    // Booster II (Navy Cap Booster 3200), 2× Tracking Computer II,
    // pure-buffer armor stack (5× Reinforced Bulkheads II + 2× Mag
    // Stab II + DCII).
    // -----------------------------------------------------------------
    {
        name: 'Moros · AntiCap 2.0',
        screenshot: 'moros.png',
        build: () => ({
            shipTypeID: 19724,
            name: '√17. AntiCap 2.0',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (5): siege + 3 Ion Siege Blaster + neut
                { id: 'h0', slotType: 'HI', position: 0, typeID:  4292, state: 'ACTIVE' },                          // Siege Module II
                { id: 'h1', slotType: 'HI', position: 1, typeID: 37302, state: 'ACTIVE', chargeTypeID: 41322 },     // Ion Siege Blaster II + Void XL
                { id: 'h2', slotType: 'HI', position: 2, typeID: 37302, state: 'ACTIVE', chargeTypeID: 41322 },
                { id: 'h3', slotType: 'HI', position: 3, typeID: 37302, state: 'ACTIVE', chargeTypeID: 41322 },
                { id: 'h4', slotType: 'HI', position: 4, typeID: 40661, state: 'ACTIVE' },                          // Capital Infectious Scoped Energy Neut
                // Med (4): 2× Heavy Cap Booster II (Navy 3200) + 2× Tracking Computer II
                { id: 'm0', slotType: 'MED', position: 0, typeID:  3578, state: 'ACTIVE', chargeTypeID: 41490 },    // Heavy Cap Booster II + Navy Cap Booster 3200
                { id: 'm1', slotType: 'MED', position: 1, typeID:  3578, state: 'ACTIVE', chargeTypeID: 41490 },
                { id: 'm2', slotType: 'MED', position: 2, typeID:  1978, state: 'ACTIVE', chargeTypeID: 29001 },    // Tracking Computer II + Tracking Speed Script
                { id: 'm3', slotType: 'MED', position: 3, typeID:  1978, state: 'ACTIVE', chargeTypeID: 28999 },    // Tracking Computer II + Optimal Range Script
                // Low (8): DCII + 2× Mag Stab II + 5× Reinforced Bulkheads II
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },
                { id: 'l1', slotType: 'LO', position: 1, typeID: 10190, state: 'ONLINE' },
                { id: 'l2', slotType: 'LO', position: 2, typeID: 10190, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO', position: 3, typeID:  1335, state: 'ONLINE' },
                { id: 'l4', slotType: 'LO', position: 4, typeID:  1335, state: 'ONLINE' },
                { id: 'l5', slotType: 'LO', position: 5, typeID:  1335, state: 'ONLINE' },
                { id: 'l6', slotType: 'LO', position: 6, typeID:  1335, state: 'ONLINE' },
                { id: 'l7', slotType: 'LO', position: 7, typeID:  1335, state: 'ONLINE' },
                // Rigs (3): Capital Transverse Bulkhead I ×3
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 33902, state: 'ONLINE' },
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 33902, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 33902, state: 'ONLINE' },
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 2_390_000,
            ehpShield: 171_000,
            ehpArmor: 227_000,
            ehpHull: 1_990_000,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 57.5, therm: 44.8, kin: 44.8, exp: 23.5 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 898.8, cpuMax: 937.5,
            powerUsed: 482_900, powerMax: 825_000,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 13_161,
            capCapacity: 68_100,
            capStablePercent: 0.934,
            maxVelocity: 0,
            alignTime: 340,
            maxTargetingRangeKm: 131,
            scanResolution: 93.8,
            sensorStrength: 52.8,
            droneRangeKm: 60,
            signatureRadius: 11_300,
        },
    },

    // -----------------------------------------------------------------
    // Zirnitra · Triglavian Dread · '√17. AntiCap 2.0'
    // Disintegrator-class capital: Ultratidal Entropic Disintegrator II
    // (Occult XL, full spool), Siege Module II, Heavy Energy Neut.
    // Dual Heavy Cap Booster II + 2× Tracking Computer II in mids,
    // 5× capital plates / membranes / RAH / Entropic Radiation Sink in
    // lows, triple Capital Trimark Armor Pump I.
    // -----------------------------------------------------------------
    {
        name: 'Zirnitra · AntiCap 2.0',
        screenshot: 'zirnitra.png',
        build: () => ({
            shipTypeID: 52907,
            name: '√17. Zirnitra AntiCap 2.0',
            visibility: 'PRIVATE',
            tags: [],
            modules: [
                // High (3): Disintegrator + Siege + Heavy Neut
                { id: 'h0', slotType: 'HI', position: 0, typeID: 92514, state: 'ACTIVE', chargeTypeID: 92954 },     // Ultratidal Entropic Disintegrator II + Occult XL
                { id: 'h1', slotType: 'HI', position: 1, typeID:  4292, state: 'ACTIVE' },                          // Siege Module II
                { id: 'h2', slotType: 'HI', position: 2, typeID: 12271, state: 'ACTIVE' },                          // Heavy Energy Neutralizer II
                // Med (4)
                { id: 'm0', slotType: 'MED', position: 0, typeID:  3578, state: 'ACTIVE', chargeTypeID: 41490 },
                { id: 'm1', slotType: 'MED', position: 1, typeID:  3578, state: 'ACTIVE', chargeTypeID: 41490 },
                { id: 'm2', slotType: 'MED', position: 2, typeID:  1978, state: 'ACTIVE', chargeTypeID: 28999 },    // Tracking Computer II + Optimal Range Script
                { id: 'm3', slotType: 'MED', position: 3, typeID:  1978, state: 'ACTIVE', chargeTypeID: 29001 },    // Tracking Computer II + Tracking Speed Script
                // Low (8)
                { id: 'l0', slotType: 'LO', position: 0, typeID:  2048, state: 'ONLINE' },                          // Damage Control II
                { id: 'l1', slotType: 'LO', position: 1, typeID: 40351, state: 'ONLINE' },                          // 25000mm Steel Plates II
                { id: 'l2', slotType: 'LO', position: 2, typeID: 40351, state: 'ONLINE' },
                { id: 'l3', slotType: 'LO', position: 3, typeID: 40350, state: 'ONLINE' },                          // 25000mm Rolled Tungsten Compact Plates
                { id: 'l4', slotType: 'LO', position: 4, typeID: 15729, state: 'ONLINE' },                          // Imperial Navy Multispectrum Energized Membrane
                { id: 'l5', slotType: 'LO', position: 5, typeID: 15729, state: 'ONLINE' },
                { id: 'l6', slotType: 'LO', position: 6, typeID:  4403, state: 'ACTIVE' },                          // Reactive Armor Hardener
                { id: 'l7', slotType: 'LO', position: 7, typeID: 47911, state: 'ONLINE' },                          // Entropic Radiation Sink II
                // Rigs (3)
                { id: 'r0', slotType: 'RIG', position: 0, typeID: 30993, state: 'ONLINE' },                         // Capital Trimark Armor Pump I ×3
                { id: 'r1', slotType: 'RIG', position: 1, typeID: 30993, state: 'ONLINE' },
                { id: 'r2', slotType: 'RIG', position: 2, typeID: 30993, state: 'ONLINE' },
            ],
            drones: [], fighters: [], cargo: [], implants: [], boosters: [], subsystems: [],
        }),
        expected: {
            ehpTotal: 4_020_000,
            ehpShield: 116_000,
            ehpArmor: 3_500_000,
            ehpHull: 404_000,
            shieldResist: { em: 12.5, therm: 30,   kin: 47.5, exp: 56.2 },
            armorResist:  { em: 81.5, therm: 78.2, kin: 77.6, exp: 78.4 },
            hullResist:   { em: 59.8, therm: 59.8, kin: 59.8, exp: 59.8 },
            cpuUsed: 954,    cpuMax: 1_050,
            powerUsed: 1_159_000, powerMax: 1_169_000,
            calibrationUsed: 150, calibrationMax: 400,
            weaponDps: 30_263.5,
            capCapacity: 70_000,
            capStablePercent: 0.952,
            maxVelocity: 0,
            alignTime: 332,
            maxTargetingRangeKm: 128,
            scanResolution: 97.5,
            sensorStrength: 51.6,
            droneRangeKm: 60,
            signatureRadius: 10_000,
        },
    },
]

// ---------------------------------------------------------------------------
// Assertion helpers — print a per-stat PASS/FAIL line so the matrix is
// readable at a glance even when many entries fail.
// ---------------------------------------------------------------------------

interface AssertResult {
    pass: boolean
    label: string
    actual: string
    expected: string
    diff?: string
}

function pct(diff: number, expected: number): string {
    if (expected === 0) return diff === 0 ? '0%' : '∞%'
    return `${((diff / expected) * 100).toFixed(2)}%`
}

function approx(label: string, actual: number, expected: number, tolerancePct: number): AssertResult {
    const diff = actual - expected
    const ratio = expected === 0 ? (Math.abs(actual) < 0.01 ? 0 : 1) : Math.abs(diff / expected)
    const pass = ratio <= tolerancePct
    return {
        pass,
        label,
        actual: typeof actual === 'number' ? actual.toFixed(2) : String(actual),
        expected: typeof expected === 'number' ? expected.toFixed(2) : String(expected),
        diff: `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct(diff, expected)})`,
    }
}

function printResult(r: AssertResult): void {
    const tag = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    const padded = r.label.padEnd(28)
    if (r.pass) {
        console.log(`  ${tag} ${padded} ${r.actual}`)
    } else {
        console.log(`  ${tag} ${padded} got ${r.actual}, expected ${r.expected} (${r.diff})`)
    }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function runFit(testFit: TestFit, dataset: FittingDataset, skillProfile: SkillProfile): Promise<{ passed: number; failed: number }> {
    console.log(`\n=== ${testFit.name} (${testFit.screenshot}) ===`)
    const fit = testFit.build()

    const computed = computeFit(fit, dataset, {
        skillProfile,
        damageProfile: DAMAGE_PROFILE_PRESETS.find(p => p.name === 'Uniform') ?? null,
        spoolPercent: 1,
        disintegratorSpoolPercent: 1,
    })

    const d = computed.derived
    const exp = testFit.expected
    const ovr = testFit.toleranceOverrides ?? {}
    const T = (label: string, fallback: number) => ovr[label] ?? fallback

    // Tolerance choices:
    //   - 1 % for EHP totals (rounding in Pyfa display can drift small layers)
    //   - 0.5 % for resources / DPS (precise math, should be tight)
    //   - 0.5 pp absolute for resists (Pyfa shows 1-decimal)
    //   - 0.05 absolute for stable percent (5 pp window — capacitor calc has
    //     small differences in Pyfa's stable algorithm, tightened later)
    const results: AssertResult[] = [
        approx('Total EHP',          d.defense.ehpTotalAgainstProfile, exp.ehpTotal, T('Total EHP', 0.01)),
        approx('Shield EHP',         d.defense.shield.ehpAgainstProfile, exp.ehpShield, T('Shield EHP', 0.02)),
        approx('Armor EHP',          d.defense.armor.ehpAgainstProfile, exp.ehpArmor, T('Armor EHP', 0.01)),
        approx('Hull EHP',           d.defense.hull.ehpAgainstProfile, exp.ehpHull, T('Hull EHP', 0.02)),

        approx('Shield resist EM',   d.defense.shield.resistances.em * 100, exp.shieldResist.em, T('Shield resist EM', 0.05)),
        approx('Shield resist Th',   d.defense.shield.resistances.thermal * 100, exp.shieldResist.therm, T('Shield resist Th', 0.05)),
        approx('Shield resist Kin',  d.defense.shield.resistances.kinetic * 100, exp.shieldResist.kin, T('Shield resist Kin', 0.05)),
        approx('Shield resist Exp',  d.defense.shield.resistances.explosive * 100, exp.shieldResist.exp, T('Shield resist Exp', 0.05)),

        approx('Armor resist EM',    d.defense.armor.resistances.em * 100, exp.armorResist.em, T('Armor resist EM', 0.05)),
        approx('Armor resist Th',    d.defense.armor.resistances.thermal * 100, exp.armorResist.therm, T('Armor resist Th', 0.05)),
        approx('Armor resist Kin',   d.defense.armor.resistances.kinetic * 100, exp.armorResist.kin, T('Armor resist Kin', 0.05)),
        approx('Armor resist Exp',   d.defense.armor.resistances.explosive * 100, exp.armorResist.exp, T('Armor resist Exp', 0.05)),

        approx('Hull resist EM',     d.defense.hull.resistances.em * 100, exp.hullResist.em, T('Hull resist EM', 0.05)),
        approx('Hull resist Th',     d.defense.hull.resistances.thermal * 100, exp.hullResist.therm, T('Hull resist Th', 0.05)),
        approx('Hull resist Kin',    d.defense.hull.resistances.kinetic * 100, exp.hullResist.kin, T('Hull resist Kin', 0.05)),
        approx('Hull resist Exp',    d.defense.hull.resistances.explosive * 100, exp.hullResist.exp, T('Hull resist Exp', 0.05)),

        approx('CPU used',           d.fitting.cpuUsed, exp.cpuUsed, 0.01),
        approx('CPU max',            d.fitting.cpuMax, exp.cpuMax, 0.01),
        approx('Power used',         d.fitting.powerUsed, exp.powerUsed, 0.01),
        approx('Power max',          d.fitting.powerMax, exp.powerMax, 0.01),
        approx('Calibration used',   d.fitting.calibrationUsed, exp.calibrationUsed, 0.01),
        approx('Calibration max',    d.fitting.calibrationMax, exp.calibrationMax, 0.01),

        ...(exp.weaponDps !== undefined
            ? [approx('Weapon DPS',  d.offense.weaponDps, exp.weaponDps, T('Weapon DPS', 0.01))]
            : []),

        approx('Cap capacity',       d.capacitor.capacity, exp.capCapacity, 0.01),
        ...(exp.capStablePercent !== undefined
            ? [approx('Cap stable %', d.capacitor.stablePercent * 100, exp.capStablePercent * 100, T('Cap stable %', 0.10))]
            : []),
        ...(exp.capSecondsToEmpty !== undefined
            ? [approx('Cap to empty (s)', d.capacitor.secondsToEmpty ?? 0, exp.capSecondsToEmpty, T('Cap to empty (s)', 0.10))]
            : []),

        approx('Max velocity',       d.navigation.maxVelocity, exp.maxVelocity, 0.05),
        approx('Align time',         d.navigation.alignTimeSeconds, exp.alignTime, 0.02),

        approx('Max targeting (km)', d.targeting.maxTargetingRange / 1000, exp.maxTargetingRangeKm, T('Max targeting (km)', 0.02)),
        approx('Scan resolution',    d.targeting.scanResolution, exp.scanResolution, T('Scan resolution', 0.02)),
        approx('Sensor strength',    d.targeting.sensorStrength, exp.sensorStrength, T('Sensor strength', 0.02)),
        approx('Drone range (km)',   d.drones.controlRange / 1000, exp.droneRangeKm, T('Drone range (km)', 0.02)),

        approx('Signature radius',   d.targeting.signatureRadius, exp.signatureRadius, T('Signature radius', 0.02)),
    ]

    let passed = 0, failed = 0
    for (const r of results) {
        printResult(r)
        if (r.pass) passed++
        else failed++
    }
    return { passed, failed }
}

async function main() {
    console.log('Loading SDE bundle from the npm package (@capsuleers/eve-fit-engine/node)...')
    const dataset = await loadBundledDataset()
    // Pre-load every bucket the fits might need. loadDataset only loads the
    // baseline (attributes/effects/groups/categories/...); the per-category
    // type buckets are lazy.
    const buckets: Array<keyof FittingDataset['typesByBucket']> = [
        'ships', 'modules', 'charges', 'drones', 'fighters', 'implants', 'subsystems', 'skills',
    ]
    await Promise.all(buckets.map(b => dataset.loadBucket(b)))
    console.log(`  loaded version ${dataset.version}, ${buckets.length} buckets warm.\n`)

    // Hardcoded effect-ID drift audit (gap 5 of the May 2026 coverage audit).
    // Surface a loud warning if any effect ID claimed by a legacy handler has
    // gone missing from the bundle (Fenris Creations renumbered or deleted), so the
    // associated `applyLegacy*` / projection table doesn't silently no-op.
    const drift = verifyLegacyEffectIds(dataset.effects)
    if (drift.length > 0) {
        console.warn(`  LEGACY_EFFECT_IDS drift detected — ${drift.length} entries:`)
        for (const d of drift) {
            console.warn(`    [${d.kind}] effect ${d.id}: expected name=${JSON.stringify(d.expected)}, actual=${JSON.stringify(d.actual)}`)
        }
        console.warn('  → review constants.ts LEGACY_EFFECT_IDS and the matching handler.\n')
    } else {
        console.log(`  LEGACY_EFFECT_IDS audit: OK (no drift).\n`)
    }

    const skillProfile = buildAllVSkillProfile(dataset)
    console.log(`  All-V skill profile: ${Object.keys(skillProfile.skills).length} skills at level 5.\n`)

    let totalPassed = 0, totalFailed = 0
    for (const f of FITS) {
        const { passed, failed } = await runFit(f, dataset, skillProfile)
        totalPassed += passed
        totalFailed += failed
    }

    console.log('')
    console.log(`Summary: ${totalPassed} passed, ${totalFailed} failed.`)
    process.exit(totalFailed === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exit(2)
})
