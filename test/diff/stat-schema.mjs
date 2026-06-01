/**
 * Shared stat schema + diff for the Pyfa-parity differential harness.
 *
 * Both engines emit the SAME nested stat object (same keys + units):
 *   - our `computeFit().derived`  -> oursToSchema()
 *   - pyfa eos (oracle/pyfa_oracle.py) -> already this shape
 * flatten() + diffStats() then compare leaf-by-leaf with a relative tolerance
 * (default 1%) plus an absolute epsilon (float-noise floor).
 *
 * Units are normalized so both sides match: resists in %, targeting/drone range
 * in km, cap stable in %, everything else in raw EVE units.
 */

const pct = (resonanceResist) => (resonanceResist == null ? null : resonanceResist * 100)

/** Map our engine's `derived` block to the common schema (matches pyfa_oracle). */
export function oursToSchema(d) {
    const def = d.defense, off = d.offense, cap = d.capacitor, nav = d.navigation, tgt = d.targeting, fit = d.fitting
    const R = (layer) => ({
        em: pct(layer.resistances.em), thermal: pct(layer.resistances.thermal),
        kinetic: pct(layer.resistances.kinetic), explosive: pct(layer.resistances.explosive),
    })
    return {
        fitting: {
            cpuUsed: fit.cpuUsed, cpuMax: fit.cpuMax,
            powerUsed: fit.powerUsed, powerMax: fit.powerMax,
            calibrationUsed: fit.calibrationUsed, calibrationMax: fit.calibrationMax,
        },
        defense: {
            shieldHp: def.shield.hp, armorHp: def.armor.hp, hullHp: def.hull.hp,
            shieldResist: R(def.shield), armorResist: R(def.armor), hullResist: R(def.hull),
            // oracle uses a uniform 25/25/25/25 damage pattern; our default profile
            // is uniform too, so ehpAgainstProfile is the comparable value.
            ehpShield: def.shield.ehpAgainstProfile, ehpArmor: def.armor.ehpAgainstProfile,
            ehpHull: def.hull.ehpAgainstProfile, ehpTotal: def.ehpTotalAgainstProfile,
        },
        offense: {
            weaponDps: off.weaponDps, droneDps: off.droneDps,
            totalDps: off.totalDps,
            // pyfa's getWeaponVolley() counts every weapon EXCEPT drones/
            // fighters (which fire continuously, no synchronized volley) —
            // turrets, launchers AND smartbombs/doomsdays all contribute. Our
            // off.alphaStrike folds in drone+fighter alpha, so subtract only
            // those for parity.
            alphaStrike: (off.breakdown ?? [])
                .filter(b => b.kind !== 'DRONE' && b.kind !== 'FIGHTER')
                .reduce((s, b) => s + (b.alpha ?? 0), 0),
        },
        capacitor: {
            capacity: cap.capacity, stable: cap.stable,
            stablePercent: cap.stable ? cap.stablePercent * 100 : null,
            secondsToEmpty: cap.stable ? null : (cap.secondsToEmpty ?? null),
        },
        navigation: {
            maxVelocity: nav.maxVelocity, alignTime: nav.alignTimeSeconds, warpSpeed: nav.warpSpeed,
            mass: nav.mass, agility: nav.agility, signatureRadius: tgt.signatureRadius,
        },
        targeting: {
            maxTargetingRange: tgt.maxTargetingRange / 1000, scanResolution: tgt.scanResolution,
            sensorStrength: tgt.sensorStrength, maxLockedTargets: tgt.maxLockedTargets,
            droneControlRange: (d.drones?.controlRange ?? 0) / 1000 || null,
        },
    }
}

/** Flatten nested schema to { 'group.path': value }. */
export function flatten(obj, prefix = '') {
    const out = {}
    for (const k in obj) {
        const v = obj[k]
        const key = prefix ? `${prefix}.${k}` : k
        if (v != null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
        else out[key] = v
    }
    return out
}

/**
 * Diff two flattened stat maps. Returns [{ key, ours, pyfa, absDelta, pctDelta }]
 * for every leaf that differs beyond tolerance. Booleans must match exactly;
 * null on one side but a real number on the other is a difference.
 */
export function diffStats(ours, pyfa, { tol = 0.01, eps = 0.01 } = {}) {
    const diffs = []
    const keys = new Set([...Object.keys(ours), ...Object.keys(pyfa)])
    for (const key of keys) {
        const a = ours[key], b = pyfa[key]
        if (typeof a === 'boolean' || typeof b === 'boolean') {
            if (a !== b) diffs.push({ key, ours: a, pyfa: b, absDelta: null, pctDelta: null })
            continue
        }
        const an = a == null ? null : Number(a), bn = b == null ? null : Number(b)
        if (an == null && bn == null) continue
        if (an == null || bn == null || Number.isNaN(an) || Number.isNaN(bn)) {
            // one side missing/NaN — only flag if the present side is non-trivial
            const present = an ?? bn
            if (present != null && Math.abs(present) > eps) diffs.push({ key, ours: a ?? null, pyfa: b ?? null, absDelta: null, pctDelta: null })
            continue
        }
        const absDelta = Math.abs(an - bn)
        const threshold = Math.max(tol * Math.abs(bn), eps)
        if (absDelta > threshold) {
            diffs.push({ key, ours: an, pyfa: bn, absDelta, pctDelta: bn !== 0 ? (an - bn) / Math.abs(bn) * 100 : null })
        }
    }
    return diffs
}
