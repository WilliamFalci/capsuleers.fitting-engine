/**
 * Capacitor simulation.
 *
 * EVE's capacitor follows a non-linear S-shaped recharge curve. Per the
 * canonical formula (Pyfa / EVE-Wiki):
 *
 *     dC/dt = (10 × C_max / τ) × (√x − x)         where x = C / C_max
 *
 * τ is the `capacitorRechargeRate` attribute IN MILLISECONDS. The factor
 * stems from Newton-fit empirical data: peak recharge rate occurs at
 * x = 0.25 (i.e. cap at 25% capacity) and equals 2.5 × C_max / τ_seconds.
 *
 * Stability check: a fit is "cap stable" if at some level x ∈ (0, 1) the
 * recharge rate equals the steady-state usage rate. Solving for that level:
 *
 *     usage = (10 × C_max / τ) × (√x − x)
 *     ⇒ √x − x = u  where u = usage × τ / (10 × C_max)
 *
 * The function (√x − x) is concave on [0, 1] with maximum 0.25 at x=0.25,
 * so a solution exists ⇔ u ≤ 0.25, i.e. usage ≤ 2.5 × C_max / τ. The
 * smaller of the two roots is the *unstable* equilibrium (cap drops to it
 * if it dips below 25%); the larger root is the stable equilibrium and is
 * what the UI calls "cap stable at X%".
 *
 * If the fit is NOT stable, we report seconds-to-empty: integration of
 * dC/dt from 100% down to 0% under the assumption that drain rate is
 * constant at `usage` (a slight under-estimate; the true integral is
 * shorter because the recharge contribution decreases as cap drops).
 *
 * Module drain: each module's effect with a `dischargeAttributeID` reads
 * its drain per cycle from that attribute, and its cycle duration from
 * `durationAttributeID`. Drain per second = discharge / (duration / 1000).
 * Only modules in ACTIVE / OVERLOAD state contribute (offline + online +
 * passive don't drain).
 *
 * --- Cap booster handling: discrete-event simulation (Pyfa parity) ---
 *
 * The naïve closed-form approach amortises booster injection across the
 * (charges × cycle + reload) window and treats it as a constant negative
 * drain. That's wrong by 5-15 % for fits with a heavy cap booster + high
 * net injection: in reality, booster activations that would push cap above
 * 100 % are POSTPONED (`awaitingInjectors` queue in Pyfa's `capSim.py`).
 * The deferred injection is applied later when cap dips low enough to
 * absorb it without overshoot.
 *
 * The closed-form ignores this overshoot loss and reports a higher cap
 * stable % than reality. Apoc Navy + Heavy F-RX shows 93 % closed-form vs
 * 79.9 % Pyfa — 13 pp gap.
 *
 * Fix: when any active module has a cap booster effect (effectID 48), run
 * a discrete-event simulator that mirrors Pyfa's `CapSimulator`:
 *   - Min-heap of (t_now, duration, capNeed, shot, clipSize, reloadTime,
 *     isInjector) tuples (negative capNeed for boosters = injection).
 *   - At each event, regenerate cap analytically since the previous event,
 *     postpone overshoot injectors, drain/inject, advance.
 *   - Stop when (cap_now ≥ cap_at_period_start AND awaiting injectors
 *     match) — the system is stable. Or when cap < 0 (unstable).
 *
 * UI metric matches Pyfa: `capState = (cap_low + cap_low_pre) / (2·C_max)`
 * — average of the post-drain low watermark and the pre-drain low
 * watermark. Cycle-average operating cap level, which is what writers
 * actually care about (the closed-form equilibrium is where rate goes to
 * zero, NOT the average level under a periodic drain schedule).
 *
 * Trap encountered & avoided. The OLD per-load amortisation
 *     rate = N × (capNeed - inject) / (N × cycle + reload)
 * is mathematically correct as the *long-run mean injection rate* but the
 * cap-stable solver assumes that mean is delivered every instant — which
 * over-credits the booster because postponed injections lose effective
 * value (they get clipped at 100 % cap).
 */

import { ATTR } from '../constants'
import { isTurretWeapon } from '../fitChecks'
import type { FitContext } from '../fitContext'
import type { ItemState } from '../itemState'
import type { FittingDataset, SdeEffect } from '../types'

export interface CapacitorReport {
    /** Max capacitor capacity (GJ). */
    capacity: number
    /** Recharge time τ in milliseconds (raw SDE value). */
    rechargeMs: number
    /** Peak recharge rate, GJ/s, achieved at 25% capacity. */
    peakRechargeRate: number
    /** Total active drain across all online/active modules, GJ/s. Reported
     *  as the *gross* drain (before accounting for cap booster injection)
     *  when the fit has injectors. */
    usagePerSecond: number
    /** True iff a stable equilibrium exists. */
    stable: boolean
    /** Equilibrium cap level (0..1) when stable. Always ≥ 0.25 in the
     *  closed-form path; in the simulator path this is Pyfa's
     *  (cap_low + cap_low_pre) / (2·capacity). */
    stablePercent: number
    /** Time until cap reaches 0 from full, in seconds. Only meaningful when
     *  not stable; undefined when stable. */
    secondsToEmpty?: number
}

export function computeCapacitor(
    ctx: FitContext,
    dataset: FittingDataset,
): CapacitorReport {
    const ship = ctx.ship
    const capacity = ship.getFinal(ATTR.CAPACITOR_CAPACITY, 0)
    const rechargeMs = ship.getFinal(ATTR.CAPACITOR_RECHARGE_RATE, 0)

    if (capacity <= 0 || rechargeMs <= 0) {
        return { capacity, rechargeMs, peakRechargeRate: 0, usagePerSecond: 0, stable: false, stablePercent: 0 }
    }

    const peakRechargeRate = peakRecharge(capacity, rechargeMs)

    // Build the drain table once. If any entry is a cap-booster injector
    // (negative capNeed with isInjector=true), branch to the discrete
    // simulator; otherwise use the closed-form root solver which is exact
    // for constant drain.
    const { drains, totalGrossDrain, hasInjector } = collectDrains(ctx, dataset)

    if (drains.length === 0) {
        // No drain at all → trivially stable at 100%.
        return {
            capacity,
            rechargeMs,
            peakRechargeRate,
            usagePerSecond: 0,
            stable: true,
            stablePercent: 1,
        }
    }

    // Always run the discrete simulator now: Pyfa's headline metric for
    // both injected and non-injected fits is `(cap_low + cap_low_pre) /
    // 2`, the cycle-average operating cap level — and that's NOT equal to
    // the closed-form equilibrium even when the drain is constant. For
    // staggered drains the cap bobs around the equilibrium and the
    // average is what writers compare against in Pyfa's UI.
    //
    // Closed-form is retained as a fallback only when the simulator times
    // out without converging (defensive — shouldn't happen in practice).
    void hasInjector
    const sim = runCapSim({ capacity, rechargeMs, peakRechargeRate, drains, grossDrain: totalGrossDrain })
    if (sim.stable || sim.secondsToEmpty !== undefined) return sim
    return solveClosedForm({ capacity, rechargeMs, peakRechargeRate, usagePerSecond: totalGrossDrain })
}

/**
 * Peak passive recharge rate at 25% capacity. Used for both the capacitor
 * and (with shield_capacity / shield_recharge_rate as inputs) the passive
 * shield regen.
 *
 *   rate(x) = (10 × C / τ) × (√x − x)
 *   peak occurs at x = 0.25 → rate_max = 2.5 × C / τ_seconds
 */
export function peakRecharge(capacity: number, rechargeMs: number): number {
    if (capacity <= 0 || rechargeMs <= 0) return 0
    return (2.5 * capacity) / (rechargeMs / 1000)
}

/**
 * Recharge rate at an arbitrary cap level (0..1). Useful for time-domain
 * simulations / charts.
 */
export function rechargeRateAt(capacity: number, rechargeMs: number, fillFraction: number): number {
    if (capacity <= 0 || rechargeMs <= 0) return 0
    const x = Math.max(0, Math.min(1, fillFraction))
    return (10 * capacity / (rechargeMs / 1000)) * (Math.sqrt(x) - x)
}

// ---------------------------------------------------------------------------
// Closed-form root solver (no cap boosters present).
// ---------------------------------------------------------------------------

interface ClosedFormInput {
    capacity: number
    rechargeMs: number
    peakRechargeRate: number
    usagePerSecond: number
}

function solveClosedForm(inp: ClosedFormInput): CapacitorReport {
    const { capacity, rechargeMs, peakRechargeRate, usagePerSecond } = inp
    if (usagePerSecond <= 0) {
        return { capacity, rechargeMs, peakRechargeRate, usagePerSecond: 0, stable: true, stablePercent: 1 }
    }
    // Solve √x − x = u  for x ∈ [0.25, 1]. Closed form via quadratic in √x.
    const u = (usagePerSecond * (rechargeMs / 1000)) / (10 * capacity)
    if (u > 0.25) {
        return {
            capacity,
            rechargeMs,
            peakRechargeRate,
            usagePerSecond,
            stable: false,
            stablePercent: 0,
            secondsToEmpty: integrateTimeToEmpty(capacity, peakRechargeRate, usagePerSecond),
        }
    }
    const y = (1 + Math.sqrt(1 - 4 * u)) / 2
    return {
        capacity,
        rechargeMs,
        peakRechargeRate,
        usagePerSecond,
        stable: true,
        stablePercent: y * y,
    }
}

function integrateTimeToEmpty(capacity: number, peakRechargeRate: number, usage: number): number | undefined {
    // Trapezoidal integration of dC/dt = recharge(C) - drain over [C_max, 0].
    const N = 200
    let integral = 0
    let prevInv = 1 / Math.max(usage, 1e-9)
    for (let i = 1; i <= N; i++) {
        const x = i / N
        const rate = 4 * peakRechargeRate * (Math.sqrt(x) - x)
        const net = usage - rate
        const inv = 1 / Math.max(net, 1e-9)
        integral += (prevInv + inv) * 0.5 / N
        prevInv = inv
    }
    const seconds = capacity * integral
    return Number.isFinite(seconds) ? seconds : undefined
}

// ---------------------------------------------------------------------------
// Drain collection.
// ---------------------------------------------------------------------------

/**
 * One activation source for the simulator. Mirrors Pyfa's tuple shape:
 *   (cycleMs, capNeed, clipSize, reloadMs, isInjector, disableStagger)
 *
 * `capNeed` is positive for normal modules (drain) and negative for cap
 * boosters (the injection is `bonus - moduleCapNeed`, sign-flipped).
 */
interface DrainEntry {
    cycleMs: number
    capNeed: number
    /** Charges per load. 0 means infinite (no reload). */
    clipSize: number
    reloadMs: number
    isInjector: boolean
    /** Disable staggering for this module (Pyfa stags turret drain to
     *  smooth jitter — irrelevant to stability outcome but we keep the
     *  flag for parity). */
    disableStagger: boolean
}

interface DrainCollection {
    drains: DrainEntry[]
    /** Sum of (capNeed / cycleSec) across positive entries, GJ/s. Used as
     *  the "usagePerSecond" headline number when no injectors present, and
     *  as a fallback / display value when they are. */
    totalGrossDrain: number
    hasInjector: boolean
}

const CAP_BOOSTER_EFFECT_ID = 48
const ATTR_CAPACITOR_BONUS = 67
const ATTR_CAPACITOR_NEED  = 6
const ATTR_DURATION_MS     = 73
const ATTR_REACTIVATION_MS = 669
const ATTR_RELOAD_TIME     = 1795
const ATTR_CAPACITY        = 38
const ATTR_VOLUME          = 161

function collectDrains(ctx: FitContext, dataset: FittingDataset): DrainCollection {
    const drains: DrainEntry[] = []
    let totalGrossDrain = 0
    let hasInjector = false

    for (const m of ctx.modules) {
        if (m.state !== 'ACTIVE' && m.state !== 'OVERLOAD') continue

        // Cap booster — special-case before the generic effect dispatch
        // so we don't double-count the activation cost.
        if (m.effectIDs.has(CAP_BOOSTER_EFFECT_ID) && m.charge) {
            const entry = boosterDrainEntry(m)
            if (entry) {
                drains.push(entry)
                hasInjector = true
            }
            continue
        }

        // A module activates ONCE per cycle and pays its cap cost once,
        // regardless of how many of its effects reference the same
        // capacitorNeed/duration. Pyfa models cap per-module, so it never
        // double-counts; we collect via effects, so we must dedupe identical
        // drain entries WITHIN a module. The only published type that trips
        // this is "Dual Afocal Light Laser I" (typeID 6633), the lone module
        // in the SDE carrying two discharge-bearing effects (10 + 263) that
        // both point at attr 6 / attr 51 — without the dedupe its cap drain
        // was counted twice (2× usage → ~half the true time-to-empty).
        const seen = new Set<string>()
        for (const eid of m.effectIDs) {
            const effect = dataset.effects.get(eid)
            if (!effect) continue
            const entry = drainEntryFromEffect(effect, m)
            if (!entry) continue
            const sig = `${entry.cycleMs}|${entry.capNeed}|${entry.clipSize}|${entry.reloadMs}|${entry.isInjector ? 1 : 0}|${entry.disableStagger ? 1 : 0}`
            if (seen.has(sig)) continue
            seen.add(sig)
            drains.push(entry)
            if (entry.capNeed > 0 && entry.cycleMs > 0) {
                totalGrossDrain += entry.capNeed / (entry.cycleMs / 1000)
            }
        }
    }
    return { drains, totalGrossDrain, hasInjector }
}

function drainEntryFromEffect(effect: SdeEffect, mod: ItemState): DrainEntry | null {
    if (effect.dischargeAttributeID === undefined) return null
    const discharge = mod.getFinal(effect.dischargeAttributeID, 0)
    if (discharge <= 0) return null
    const baseCycleMs = effect.durationAttributeID !== undefined
        ? mod.getFinal(effect.durationAttributeID, 0)
        : 1000  // fallback for no-duration discharge effects
    if (baseCycleMs <= 0) return null
    // Pyfa charges cap over the FULL cycle = duration + moduleReactivationDelay
    // (fit.py __generateDrain). Modules with a long reactivation lockout (Warp
    // Core Stabilizer 150 s, MJD, cloaks) drain far less per second than their
    // bare duration implies; without this we overstate their cap usage ~11×.
    // Round to an INTEGER millisecond cycle, exactly as pyfa does
    // (`int(fullCycleTime)` in fit.py __generateDrain). This is load-bearing
    // for the sim: the period optimisation takes the LCM of all cycle times,
    // and a fractional cycle (e.g. 7500.0000001 from attribute math) makes the
    // gcd/LCM degenerate into an astronomically large period, so the
    // stable-period early-exit never fires — the sim then runs to t_max and
    // captures a deeper `cap_lowest_pre` than pyfa's early-exit, skewing the
    // reported stable %. Integer cycles keep the LCM (and thus the exit) sane.
    const cycleMs = Math.round(baseCycleMs + mod.getFinal(ATTR_REACTIVATION_MS, 0))
    return {
        cycleMs,
        capNeed: discharge,
        clipSize: 0,           // ammo doesn't reload for cap purposes on regular modules
        reloadMs: 0,
        isInjector: false,
        // Pyfa: `disableStagger = mod.hardpoint == TURRET`. Turrets fire as a
        // synchronized volley (their cap drains aggregate, capNeed × N at the
        // shared cycle); everything else is staggered evenly across its cycle.
        // Without this, N turrets were staggered (one drain at cycle/N) instead
        // of N together, shifting the cap timeline (time-to-empty off ~5-10 %).
        disableStagger: isTurretWeapon(mod.type),
    }
}

function boosterDrainEntry(mod: ItemState): DrainEntry | null {
    const charge = mod.charge
    if (!charge) return null
    const capNeed = mod.getFinal(ATTR_CAPACITOR_NEED, 0)
    const inject  = charge.getFinal(ATTR_CAPACITOR_BONUS, 0)
    const cycleMs = Math.round(mod.getFinal(ATTR_DURATION_MS, 0))  // integer cycle (see drainEntryFromEffect)
    if (cycleMs <= 0) return null
    let reloadMs = Math.round(mod.getFinal(ATTR_RELOAD_TIME, 0))
    if (reloadMs <= 0) reloadMs = 10_000 // Pyfa default for cap boosters
    const capacity = mod.getFinal(ATTR_CAPACITY, 0)
    const chargeVol = charge.getFinal(ATTR_VOLUME, 0)
    // Charges the booster holds = floor(capacity / chargeVolume). Pyfa feeds
    // this as `numShots`; a value of 0 (charge too big to fit even one — the
    // sim's `if clipSize:` is then falsy) means NO reload, i.e. the injector is
    // treated as effectively infinite. We must NOT clamp this up to 1: forcing
    // clipSize=1 made every cycle trigger a reload gap, roughly halving the
    // sustained injection and flipping cap-booster fits from stable to
    // depleting (Orthrus 150s→90s, several capitals stable→unstable).
    const charges = (capacity > 0 && chargeVol > 0) ? Math.floor(capacity / chargeVol) : 0
    return {
        cycleMs,
        // Pyfa convention: positive capNeed = drain, negative = injection.
        // For boosters the *net* per-cycle change is (capNeed_module - inject_charge).
        capNeed: capNeed - inject,
        clipSize: charges,
        reloadMs,
        isInjector: true,
        disableStagger: false,
    }
}

// ---------------------------------------------------------------------------
// Discrete-event simulator (cap booster path).
//
// Faithful port of Pyfa's `eos/capSim.py::CapSimulator`. Variable names
// kept intentionally similar to ease cross-checking against the reference.
// ---------------------------------------------------------------------------

interface SimInput {
    capacity: number
    rechargeMs: number
    peakRechargeRate: number
    drains: DrainEntry[]
    grossDrain: number
}

/** Min-heap entry mirroring Pyfa's tuple: [t_now, cycleMs, capNeed, shot, clipSize, reloadMs, isInjector]. */
type Activation = [number, number, number, number, number, number, boolean]

function lcm(a: number, b: number): number {
    if (a === 0 || b === 0) return 0
    const product = a * b
    let x = a, y = b
    while (y) { [x, y] = [y, x % y] }
    return product / x
}

class MinHeap {
    private a: Activation[] = []

    push(v: Activation): void {
        this.a.push(v)
        this.bubbleUp(this.a.length - 1)
    }

    pop(): Activation | undefined {
        if (this.a.length === 0) return undefined
        const top = this.a[0]
        const last = this.a.pop()!
        if (this.a.length > 0) {
            this.a[0] = last
            this.bubbleDown(0)
        }
        return top
    }

    private bubbleUp(i: number): void {
        const a = this.a
        while (i > 0) {
            const p = (i - 1) >> 1
            if (this.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p } else break
        }
    }

    private bubbleDown(i: number): void {
        const a = this.a, n = a.length
        for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2
            let best = i
            if (l < n && this.lt(a[l], a[best])) best = l
            if (r < n && this.lt(a[r], a[best])) best = r
            if (best === i) break
            ;[a[i], a[best]] = [a[best], a[i]]
            i = best
        }
    }

    private lt(x: Activation, y: Activation): boolean {
        // Same comparison rules as Python's tuple comparison.
        for (let i = 0; i < x.length; i++) {
            const xv = x[i], yv = y[i]
            const xn = typeof xv === 'boolean' ? (xv ? 1 : 0) : xv
            const yn = typeof yv === 'boolean' ? (yv ? 1 : 0) : yv
            if (xn < yn) return true
            if (xn > yn) return false
        }
        return false
    }
}

function runCapSim(inp: SimInput): CapacitorReport {
    const { capacity, rechargeMs, peakRechargeRate, drains, grossDrain } = inp

    // Pyfa's tau is `rechargeRate / 5.0` (where rechargeRate is the SDE
    // value in milliseconds). The recharge integration formula uses
    // exp((t_last - t_now) / tau) so tau here is also in milliseconds.
    const tau = rechargeMs / 5.0
    const capCapacity = capacity

    // --- Reset / group identical drains (Pyfa stagger heuristic). ---
    //
    // We replicate Pyfa's `reset()`: group identical (cycle, capNeed,
    // clipSize, disableStagger, reloadMs, isInjector) tuples, then emit
    // one heap entry per group with capNeed scaled by group size (or
    // staggered for clipSize=0 non-injectors). Injectors always emit one
    // entry per instance (Pyfa's "use as needed" rule).
    type GroupKey = string
    const groups = new Map<GroupKey, { entry: DrainEntry; count: number }>()
    for (const d of drains) {
        const key: GroupKey = `${d.cycleMs}|${d.capNeed}|${d.clipSize}|${d.reloadMs}|${d.isInjector ? 1 : 0}|${d.disableStagger ? 1 : 0}`
        const existing = groups.get(key)
        if (existing) existing.count++
        else groups.set(key, { entry: d, count: 1 })
    }

    const heap = new MinHeap()
    let period = 1
    let disablePeriod = false
    const stagger = true   // Pyfa hard-codes `sim.stagger = True` from fit.py

    for (const { entry, count } of groups.values()) {
        if (entry.clipSize > 0) disablePeriod = true
        if (entry.isInjector) {
            // One entry per injector instance, no staggering, no capNeed
            // multiplication — Pyfa wants them available immediately.
            for (let i = 0; i < count; i++) {
                heap.push([0, entry.cycleMs, entry.capNeed, 0, entry.clipSize, entry.reloadMs, true])
            }
            continue
        }
        let cycle = entry.cycleMs
        let capNeed = entry.capNeed
        if (stagger && !entry.disableStagger) {
            if (entry.clipSize === 0) {
                // Stagger by dividing cycle by group count.
                cycle = Math.floor(entry.cycleMs / count)
            } else {
                const staggerAmount = (entry.cycleMs * entry.clipSize + entry.reloadMs) / (count * entry.clipSize)
                for (let i = 1; i < count; i++) {
                    heap.push([
                        Math.floor(i * staggerAmount),
                        entry.cycleMs, entry.capNeed, 0, entry.clipSize, entry.reloadMs, false,
                    ])
                }
            }
        } else {
            // No staggering: aggregate all instances into one heap entry
            // with N× capNeed.
            capNeed *= count
        }
        period = lcm(period, cycle) || period
        heap.push([0, cycle, capNeed, 0, entry.clipSize, entry.reloadMs, false])
    }

    // Pyfa caps simulation runtime at 6 hours when called from `simulateCap`.
    const T_MAX = 6 * 60 * 60 * 1000
    if (disablePeriod) period = T_MAX

    // --- Main simulation loop. ---
    type AwaitingInjector = readonly [number, number, number, number, number, true]
    const awaitingInjectors: AwaitingInjector[] = []
    let awaitingSnapshot: readonly AwaitingInjector[] = []

    let cap = capCapacity
    let capLow = capCapacity
    let capLowPre = capCapacity
    let capWrap = capCapacity
    let tWrap = period
    let tLast = 0

    while (true) {
        const act = heap.pop()
        if (!act) break

        let [tNow, cycleMs, capNeed, shot, clipSize, reloadMs, isInjector] = act
        if (tNow >= T_MAX) break

        // Regenerate cap from previous event (closed-form integration of
        // EVE's S-curve over (tLast, tNow)).
        if (tNow > tLast) {
            cap = ((1.0 + (Math.sqrt(cap / capCapacity) - 1.0) * Math.exp((tLast - tNow) / tau)) ** 2) * capCapacity
        }

        if (tNow !== tLast) {
            if (cap < capLowPre) capLowPre = cap
            if (tNow === tWrap) {
                // History repeats — if cap is at least as high as last
                // period AND the awaiting injector multiset matches, the
                // setup is stable.
                if (cap >= capWrap && awaitingMatches(awaitingInjectors, awaitingSnapshot)) {
                    break
                }
                capWrap = Math.round(cap * 10) / 10  // 1 decimal stability precision
                awaitingSnapshot = awaitingInjectors.slice()
                tWrap += period
            }
        }

        tLast = tNow

        // Cap booster activation that would overshoot — postpone.
        if (isInjector && cap - capNeed > capCapacity) {
            awaitingInjectors.push([cycleMs, capNeed, shot, clipSize, reloadMs, true] as const)
        } else {
            // If we don't have enough cap, try to use a postponed booster
            // first. `goodInjectors` = ones with at least the needed amount
            // but with the smallest overshoot; otherwise the largest.
            if (capNeed > cap && cap < capCapacity) {
                while (awaitingInjectors.length > 0 && capNeed > cap && capCapacity > cap) {
                    const need = Math.min(capNeed - cap, capCapacity - cap)
                    let bestIdx = -1
                    let bestVal = -Infinity
                    let goodIdx = -1
                    let goodVal = Infinity
                    for (let i = 0; i < awaitingInjectors.length; i++) {
                        const inj = awaitingInjectors[i]
                        const provided = -inj[1]
                        if (provided >= need && provided < goodVal) { goodVal = provided; goodIdx = i }
                        if (provided > bestVal) { bestVal = provided; bestIdx = i }
                    }
                    const useIdx = goodIdx >= 0 ? goodIdx : bestIdx
                    if (useIdx < 0) break
                    const inj = awaitingInjectors[useIdx]
                    awaitingInjectors.splice(useIdx, 1)
                    cap -= inj[1]
                    if (cap > capCapacity) cap = capCapacity
                    let injTNow = tNow + inj[0]
                    let injShot = inj[2] + 1
                    if (inj[3] && injShot % inj[3] === 0) {
                        injShot = 0
                        injTNow += inj[4]
                    }
                    heap.push([injTNow, inj[0], inj[1], injShot, inj[3], inj[4], true])
                }
            }

            // Apply this activation.
            cap -= capNeed
            if (cap > capCapacity) cap = capCapacity

            if (cap < capLow) {
                if (cap < 0.0) break  // unstable
                capLow = cap
            }

            // Try to top up with awaiting injectors that won't overshoot.
            while (awaitingInjectors.length > 0 && cap < capCapacity) {
                const need = capCapacity - cap
                let bestIdx = -1
                let bestVal = -Infinity
                for (let i = 0; i < awaitingInjectors.length; i++) {
                    const inj = awaitingInjectors[i]
                    const provided = -inj[1]
                    if (provided <= need && provided > bestVal) {
                        bestVal = provided
                        bestIdx = i
                    }
                }
                if (bestIdx < 0) break
                const inj = awaitingInjectors[bestIdx]
                awaitingInjectors.splice(bestIdx, 1)
                cap -= inj[1]
                if (cap > capCapacity) cap = capCapacity
                let injTNow = tNow + inj[0]
                let injShot = inj[2] + 1
                if (inj[3] && injShot % inj[3] === 0) {
                    injShot = 0
                    injTNow += inj[4]
                }
                heap.push([injTNow, inj[0], inj[1], injShot, inj[3], inj[4], true])
            }

            // Re-queue this activation for its next cycle.
            tNow += cycleMs
            shot += 1
            if (clipSize && shot % clipSize === 0) {
                shot = 0
                tNow += reloadMs
            }
            heap.push([tNow, cycleMs, capNeed, shot, clipSize, reloadMs, isInjector])
        }
    }

    const stable = cap > 0
    if (!stable) {
        return {
            capacity,
            rechargeMs,
            peakRechargeRate,
            usagePerSecond: grossDrain,
            stable: false,
            stablePercent: 0,
            secondsToEmpty: tLast / 1000,
        }
    }

    // Match Pyfa's UI metric: `(cap_low + cap_low_pre) / (2 × C_max)`.
    const stablePercent = Math.min(1, (capLow + capLowPre) / (2 * capCapacity))

    return {
        capacity,
        rechargeMs,
        peakRechargeRate,
        usagePerSecond: grossDrain,
        stable: true,
        stablePercent,
    }
}

function awaitingMatches(
    cur: readonly (readonly [number, number, number, number, number, true])[],
    snap: readonly (readonly [number, number, number, number, number, true])[],
): boolean {
    if (cur.length !== snap.length) return false
    if (cur.length === 0) return true
    // Multiset compare via key-counter.
    const counter = new Map<string, number>()
    for (const a of cur) {
        const key = a.join(',')
        counter.set(key, (counter.get(key) ?? 0) + 1)
    }
    for (const a of snap) {
        const key = a.join(',')
        const c = counter.get(key)
        if (!c) return false
        if (c === 1) counter.delete(key)
        else counter.set(key, c - 1)
    }
    return counter.size === 0
}
