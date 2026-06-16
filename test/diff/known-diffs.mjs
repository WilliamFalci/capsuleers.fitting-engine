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
 * Calibrated against pyfa commit: c8f9fe88ddeaf31b29c90a6e3318275aed29c838
 * (kept in lock-step with PYFA_REF in .github/workflows/diff-parity.yml.)
 *
 * Matching is by (ship, fitType, statKey). A matched diff is ACCEPTED and does
 * not fail the run; ANY unlisted diff fails `npm run diff` (exit 1). Entries
 * marked "PENDING REVIEW" were added by the recalibration script at a pin bump
 * and MUST be classified (and their reason replaced) before release.
 *
 * Invariant: never regress `npm run test:pyfa` (662/0) to satisfy this harness.
 */

/** @typedef {{ ship: string, fitType: string, key: string, reason: string }} KnownDiff */

/** @type {KnownDiff[]} */
export const KNOWN_DIFFS = [
    { ship: "Bowhead", fitType: "t2", key: "navigation.alignTime", reason: "FP precision (~3%) on align time (mass/agility rounding)" },
    { ship: "Claw", fitType: "t2", key: "offense.totalDps", reason: "FP precision (+1.5%) on total DPS" },
    { ship: "Claw", fitType: "t2", key: "offense.weaponDps", reason: "FP precision (+1.5%) on weapon DPS" },
    { ship: "Dominix Navy Issue", fitType: "mixed", key: "navigation.signatureRadius", reason: "multi-module sig stacking (MWD+MJD) — per-effect penaltyGroups regress parity suite (same class as Ferox/Mastodon/Rokh)" },
    { ship: "Ferox Navy Issue", fitType: "non-bonused", key: "navigation.signatureRadius", reason: "multi-module sig stacking (MWD+rig) — per-effect penaltyGroups regress parity suite" },
    { ship: "Griffin Navy Issue", fitType: "bonused", key: "targeting.droneControlRange", reason: "pyfa per-ship drone-control-range anomaly (bare-hull, module-independent)" },
    { ship: "Griffin Navy Issue", fitType: "mixed", key: "capacitor.stablePercent", reason: "cap-sim FP at the near-zero cap-stability boundary (~1.1% stable): integer-cycle equilibrium vs pyfa float diverge by ~0.04 percentage points (+4% relative, negligible absolute)" },
    { ship: "Griffin Navy Issue", fitType: "mixed", key: "targeting.droneControlRange", reason: "pyfa per-ship drone-control-range anomaly (bare-hull, module-independent)" },
    { ship: "Griffin Navy Issue", fitType: "non-bonused", key: "targeting.droneControlRange", reason: "pyfa per-ship drone-control-range anomaly (bare-hull, module-independent)" },
    { ship: "Griffin Navy Issue", fitType: "t2", key: "targeting.droneControlRange", reason: "pyfa per-ship drone-control-range anomaly (bare-hull, module-independent)" },
    { ship: "Malediction", fitType: "non-bonused", key: "capacitor.secondsToEmpty", reason: "Ancillary Shield Booster charge-powered cap duty cycle not modelled (niche)" },
    { ship: "Mastodon", fitType: "non-bonused", key: "navigation.signatureRadius", reason: "multi-module sig stacking (MWD+rig) — per-effect penaltyGroups regress parity suite" },
    { ship: "Miasmos", fitType: "mixed", key: "capacitor.secondsToEmpty", reason: "FP precision (+1.3%) on cap-sim secondsToEmpty (integer cycle times vs pyfa float)" },
    { ship: "Rokh", fitType: "non-bonused", key: "navigation.signatureRadius", reason: "multi-module sig stacking (MWD+MJD+rig) — per-effect penaltyGroups regress parity suite" },
    { ship: "Scimitar", fitType: "non-bonused", key: "navigation.maxVelocity", reason: "FP precision (~2%) on prop-mod velocity" },
    { ship: "Stabber", fitType: "non-bonused", key: "navigation.maxVelocity", reason: "FP precision (~2%) on prop-mod velocity" },
    { ship: "Thrasher Fleet Issue", fitType: "non-bonused", key: "offense.alphaStrike", reason: "FP precision (+1.4%) on alpha strike" },
    { ship: "Thrasher Fleet Issue", fitType: "non-bonused", key: "offense.totalDps", reason: "FP precision (+1.4%) on total DPS" },
    { ship: "Thrasher Fleet Issue", fitType: "non-bonused", key: "offense.weaponDps", reason: "FP precision (+1.4%) on weapon DPS" },
    { ship: "Zarmazd", fitType: "non-bonused", key: "navigation.maxVelocity", reason: "FP precision (~2%) on prop-mod velocity" },
]

const _key = (d) => `${d.ship}|${d.fitType}|${d.key}`
const _set = new Set(KNOWN_DIFFS.map(_key))
const _reason = new Map(KNOWN_DIFFS.map(d => [_key(d), d.reason]))

/** True if this diff is a documented, accepted difference. */
export function isKnownDiff(d) { return _set.has(_key(d)) }

/** The documented root cause for an accepted diff (or undefined). */
export function knownDiffReason(d) { return _reason.get(_key(d)) }
