/**
 * Damage application against a target — what fraction of a weapon's
 * theoretical DPS actually hits given the target's signature radius,
 * speed and the engagement range. Used by the "Stats vs Target" panel
 * and the DPS-over-range graph.
 *
 * Two regimes:
 *   - TURRETS: chance-to-hit = max(0, 0.5^(range_factor² + tracking_factor²))
 *     where range_factor    = max(0, range - optimal) / falloff
 *           tracking_factor = (angular_velocity / tracking) × (sig_resolution / sig_radius)
 *     For a stationary target we set angular_velocity = 0 so only the
 *     range factor matters.
 *
 *   - MISSILES: applied_damage = base × min(1, sig_radius / explosion_radius)
 *                                       × min(1, (sig × explosion_velocity) / (target_velocity × explosion_radius))^drf
 *     The first term is the sig-radius drop-off, the second is the
 *     velocity drop-off raised to the missile's damage reduction factor.
 *
 * For drones we approximate as turrets at 0 angular velocity.
 */

import type { TargetProfile, WeaponContribution } from '../types'

/** Apply hit-chance / sig-and-velocity falloff to a weapon's DPS at the
 *  given engagement range, against the supplied target profile. Returns
 *  the effective DPS after application losses. */
export function effectiveDps(
    weapon: WeaponContribution,
    target: TargetProfile | null,
    rangeMeters: number,
): number {
    if (!target || target.signatureRadius <= 0) return weapon.dps
    if (weapon.kind === 'TURRET' || weapon.kind === 'DRONE') {
        return weapon.dps * turretApplication(weapon, target, rangeMeters)
    }
    if (weapon.kind === 'MISSILE') {
        return weapon.dps * missileApplication(weapon, target)
    }
    if (weapon.kind === 'SMARTBOMB') {
        return rangeMeters <= weapon.range.burstRange ? weapon.dps : 0
    }
    return weapon.dps
}

function turretApplication(
    weapon: WeaponContribution,
    target: TargetProfile,
    range: number,
): number {
    const optimal = weapon.range.optimal
    const falloff = weapon.range.falloff
    const tracking = weapon.range.tracking || 1e-9
    const sigRes = 40000  // typical sigRes (Pyfa default for capsuleer turrets)
    const sigTarget = target.signatureRadius || 1
    // Angular velocity = velocity / range when target moves perpendicular.
    const angular = range > 0 ? target.maxVelocity / range : 0
    const trackingFactor = (angular / tracking) * (sigRes / sigTarget)
    const rangeFactor = Math.max(0, (range - optimal) / Math.max(falloff, 1e-9))
    const exponent = trackingFactor * trackingFactor + rangeFactor * rangeFactor
    return Math.pow(0.5, exponent)
}

function missileApplication(
    weapon: WeaponContribution,
    target: TargetProfile,
): number {
    const explosionRadius = weapon.range.explosionRadius
    const explosionVelocity = weapon.range.explosionVelocity
    const drf = weapon.range.drf || 1
    if (explosionRadius <= 0 || explosionVelocity <= 0) return 1
    const sigFactor = Math.min(1, target.signatureRadius / explosionRadius)
    const velFactor = target.maxVelocity > 0
        ? Math.min(1, (target.signatureRadius * explosionVelocity) / (target.maxVelocity * explosionRadius))
        : 1
    return sigFactor * Math.pow(velFactor, drf)
}
