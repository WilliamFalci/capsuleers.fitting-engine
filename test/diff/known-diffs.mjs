/**
 * Known, accepted differences between eve-fit-engine and pyfa-org/Pyfa.
 *
 * AUTO-MANAGED by scripts/recalibrate-pyfa-pin.mjs — but the REASONS are
 * human-owned. This is the standard differential-testing escape hatch: a
 * reference implementation (pyfa) carries floating-point / modelling / per-ship
 * quirks an independent engine can't match without degrading its own
 * correctness (regressing the 662-fixture parity suite) or replicating a
 * pyfa-specific anomaly. Each entry is annotated with its ROOT CAUSE — it is NOT
 * a place to hide real bugs.
 *
 * Calibrated against pyfa commit: 8b04f3b271e614b3e103853b44a7851a63d79d0e
 * (kept in lock-step with PYFA_REF in .github/workflows/diff-parity.yml.)
 *
 * Matching is by (ship, fitType, statKey). A matched diff is ACCEPTED and does
 * not fail the run; ANY unlisted diff fails `npm run diff` (exit 1). Entries
 * marked "PENDING REVIEW" were added by the recalibration script at a pin bump
 * and MUST be classified (and their reason replaced) before release.
 *
 * Invariant: never regress `npm run test:pyfa` (662/0) to satisfy this harness.
 *
 * ---------------------------------------------------------------------------
 * This list was 19 entries and is now ONE. The other 18 were not quirks, they
 * were bugs, and each is fixed with its measurement recorded at the fix:
 * signature-radius stacking (the MJD's bloom is unpenalised in pyfa), prop-mod
 * velocity (PostMul and PostPercent share one penalty pool upstream), weapon
 * DPS (the Claw's own hull ROF bonus belongs in the chain), align time (a
 * transposed freighter effect), drone control range (one accumulator, on the
 * ship) and the Malediction's capacitor (an Interceptor's role bonus reaches a
 * Civilian Warp Disruptor, which pyfa filters by group and the SDE by skill).
 * Don't widen this list to make a red run green.
 */

/** @typedef {{ ship: string, fitType: string, key: string, reason: string }} KnownDiff */

/** @type {KnownDiff[]} */
export const KNOWN_DIFFS = [
    {
        ship: "Griffin Navy Issue", fitType: "mixed", key: "capacitor.stablePercent",
        reason: "cap-stability BOUNDARY, not a modelling difference: this fit draws 12.52 GJ/s against "
            + "11.49 GJ/s of peak recharge and is held up only by an amortised cap booster, so the "
            + "equilibrium sits at ~1.1 % of a 398 GJ capacitor — the part of the recharge curve that is "
            + "nearly vertical. We solve that equilibrium analytically, pyfa reports the minimum its "
            + "discrete simulation reaches; the two agree to 4 decimal places wherever the curve is flat "
            + "(measured: 89.3883 % on both for a Malediction) and differ by 0.043 PERCENTAGE POINTS here. "
            + "Chasing it would mean replacing the analytic solve with pyfa's time-stepped loop.",
    },
]

const _key = (d) => `${d.ship}|${d.fitType}|${d.key}`
const _set = new Set(KNOWN_DIFFS.map(_key))
const _reason = new Map(KNOWN_DIFFS.map(d => [_key(d), d.reason]))

/** True if this diff is a documented, accepted difference. */
export function isKnownDiff(d) { return _set.has(_key(d)) }

/** The documented root cause for an accepted diff (or undefined). */
export function knownDiffReason(d) { return _reason.get(_key(d)) }
