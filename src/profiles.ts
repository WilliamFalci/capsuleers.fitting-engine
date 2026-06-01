/**
 * Built-in DamageProfile and TargetProfile presets. These match the
 * canonical values Pyfa ships, sourced from the EVE Online static data
 * (NPC race damage distribution + fleet-doctrine targets).
 *
 * Presets are read-only; the editor can save custom profiles to the
 * `damage_profiles` / `target_profiles` Prisma tables, but the presets
 * here always work even before any DB row exists.
 */

import type { DamageProfile, TargetProfile } from './types'

export const DAMAGE_PROFILE_PRESETS: ReadonlyArray<DamageProfile> = [
    { name: 'Uniform',      em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25, isPreset: true },
    { name: 'EM',           em: 1,    thermal: 0,    kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'Thermal',      em: 0,    thermal: 1,    kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'Kinetic',      em: 0,    thermal: 0,    kinetic: 1,    explosive: 0,    isPreset: true },
    { name: 'Explosive',    em: 0,    thermal: 0,    kinetic: 0,    explosive: 1,    isPreset: true },
    // NPC factions — distributions roughly match canonical NPC turret/missile stats.
    { name: 'Sansha',       em: 0.56, thermal: 0.44, kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'Blood',        em: 0.62, thermal: 0.38, kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'Amarr Navy',   em: 0.58, thermal: 0.42, kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'Guristas',     em: 0,    thermal: 0.36, kinetic: 0.64, explosive: 0,    isPreset: true },
    { name: 'Caldari Navy', em: 0,    thermal: 0.32, kinetic: 0.68, explosive: 0,    isPreset: true },
    { name: 'Serpentis',    em: 0,    thermal: 0.62, kinetic: 0.38, explosive: 0,    isPreset: true },
    { name: 'Gallente',     em: 0,    thermal: 0.62, kinetic: 0.38, explosive: 0,    isPreset: true },
    { name: 'Angel',        em: 0.26, thermal: 0.13, kinetic: 0.36, explosive: 0.25, isPreset: true },
    { name: 'Minmatar',     em: 0.13, thermal: 0.18, kinetic: 0.31, explosive: 0.38, isPreset: true },
    { name: 'Mordu',        em: 0,    thermal: 0.27, kinetic: 0.73, explosive: 0,    isPreset: true },
    { name: 'Drone',        em: 0.05, thermal: 0.14, kinetic: 0.36, explosive: 0.45, isPreset: true },
    { name: 'Sleeper',      em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25, isPreset: true },
    { name: 'Triglavian',   em: 0,    thermal: 0.5,  kinetic: 0,    explosive: 0,    isPreset: true },
    { name: 'EDENCOM',      em: 0.75, thermal: 0.25, kinetic: 0,    explosive: 0,    isPreset: true },
]

export const TARGET_PROFILE_PRESETS: ReadonlyArray<TargetProfile> = [
    { name: 'None',          signatureRadius: 125,    maxVelocity: 0,      emResist: 0,    thermalResist: 0,    kineticResist: 0,    explosiveResist: 0,    isPreset: true },
    // Frigate-class
    { name: 'Frigate',       signatureRadius: 38,     maxVelocity: 380,    emResist: 0.35, thermalResist: 0.35, kineticResist: 0.35, explosiveResist: 0.35, isPreset: true },
    { name: 'AB Frigate',    signatureRadius: 60,     maxVelocity: 950,    emResist: 0.35, thermalResist: 0.35, kineticResist: 0.35, explosiveResist: 0.35, isPreset: true },
    { name: 'MWD Frigate',   signatureRadius: 200,    maxVelocity: 2000,   emResist: 0.35, thermalResist: 0.35, kineticResist: 0.35, explosiveResist: 0.35, isPreset: true },
    // Destroyer
    { name: 'Destroyer',     signatureRadius: 60,     maxVelocity: 250,    emResist: 0.4,  thermalResist: 0.4,  kineticResist: 0.4,  explosiveResist: 0.4,  isPreset: true },
    // Cruiser-class
    { name: 'Cruiser',       signatureRadius: 130,    maxVelocity: 250,    emResist: 0.5,  thermalResist: 0.5,  kineticResist: 0.5,  explosiveResist: 0.5,  isPreset: true },
    { name: 'AB Cruiser',    signatureRadius: 200,    maxVelocity: 540,    emResist: 0.5,  thermalResist: 0.5,  kineticResist: 0.5,  explosiveResist: 0.5,  isPreset: true },
    { name: 'MWD Cruiser',   signatureRadius: 500,    maxVelocity: 1100,   emResist: 0.5,  thermalResist: 0.5,  kineticResist: 0.5,  explosiveResist: 0.5,  isPreset: true },
    // BC
    { name: 'Battlecruiser', signatureRadius: 285,    maxVelocity: 180,    emResist: 0.55, thermalResist: 0.55, kineticResist: 0.55, explosiveResist: 0.55, isPreset: true },
    // BS
    { name: 'Battleship',    signatureRadius: 410,    maxVelocity: 130,    emResist: 0.6,  thermalResist: 0.6,  kineticResist: 0.6,  explosiveResist: 0.6,  isPreset: true },
    { name: 'AB Battleship', signatureRadius: 500,    maxVelocity: 280,    emResist: 0.6,  thermalResist: 0.6,  kineticResist: 0.6,  explosiveResist: 0.6,  isPreset: true },
    // Capital
    { name: 'Carrier',       signatureRadius: 3500,   maxVelocity: 90,     emResist: 0.65, thermalResist: 0.65, kineticResist: 0.65, explosiveResist: 0.65, isPreset: true },
    { name: 'Dreadnought',   signatureRadius: 12000,  maxVelocity: 75,     emResist: 0.65, thermalResist: 0.65, kineticResist: 0.65, explosiveResist: 0.65, isPreset: true },
    { name: 'Titan',         signatureRadius: 22000,  maxVelocity: 60,     emResist: 0.7,  thermalResist: 0.7,  kineticResist: 0.7,  explosiveResist: 0.7,  isPreset: true },
    // Structure
    { name: 'Astrahus',      signatureRadius: 8000,   maxVelocity: 0,      emResist: 0.5,  thermalResist: 0.5,  kineticResist: 0.5,  explosiveResist: 0.5,  isPreset: true },
    { name: 'Fortizar',      signatureRadius: 16000,  maxVelocity: 0,      emResist: 0.6,  thermalResist: 0.6,  kineticResist: 0.6,  explosiveResist: 0.6,  isPreset: true },
    { name: 'Keepstar',      signatureRadius: 30000,  maxVelocity: 0,      emResist: 0.7,  thermalResist: 0.7,  kineticResist: 0.7,  explosiveResist: 0.7,  isPreset: true },
]
