/**
 * Tank rate aggregation.
 *
 * For each defense layer (shield / armor / hull) we report:
 *   - Single-cycle repair amount (sum of all repair modules' per-cycle output)
 *   - Single-cycle duration (the longest cycle among the modules contributing
 *     — for now we use the average of cycles which is a fair shorthand when
 *     they're roughly synchronized; refining to a proper time-weighted
 *     simulation is Phase 5+ territory)
 *   - Sustained repair-per-second (sum of amount/cycle across all reppers)
 *
 * Plus shield-specific:
 *   - Passive peak shield regen (2.5 × shield_capacity / shield_recharge_seconds)
 *
 * Repair handlers are recognised by effect id via REPAIR_EFFECT_AMOUNT_ATTR
 * — that map is the (small) hand-coded table this engine maintains.
 * Modules in OFFLINE / ONLINE state don't contribute (you have to actually
 * be cycling the rep to gain HP back), only ACTIVE / OVERLOAD.
 *
 * Ancillary shield/armor reps are treated as plain reps in this iteration:
 * their FUELED variant doubles output when loaded with a charge, but the
 * doubling is conditional on cap drain semantics (no cap = doubled rate).
 * Modelling that requires the cap simulator output and proper charge
 * tracking — Phase 5 task. For now, ancillary reps report their unfueled
 * baseline.
 */

import { ATTR, REPAIR_EFFECT_AMOUNT_ATTR } from '../constants'
import type { FitContext } from '../fitContext'
import { peakRecharge } from './capacitor'

/** Nanite Repair Paste typeID. Loaded as charge into Ancillary Armor
 *  Repairers, multiplies their per-cycle armor repair output by 3×. Pyfa
 *  hardcodes the same constant. */
const NANITE_REPAIR_PASTE_TYPE_ID = 28668
const ANCILLARY_REP_PASTE_MULTIPLIER = 3
/** Effect IDs that consume Nanite Repair Paste. Both the local AAR
 *  (`5275`) and the remote AAR (`6651`) accept paste and triple their
 *  amount when the loaded charge is paste. ASBs don't take paste — they
 *  take cap booster charges and double their amount under different
 *  semantics; that's a separate handler (Phase 5+). */
const PASTE_FUELED_REP_EFFECTS: ReadonlySet<number> = new Set([5275, 6651])

export interface TankRates {
    shieldRepairAmount: number
    shieldRepairDuration: number      // seconds, average cycle of contributing modules
    shieldRepairPerSecond: number
    /** Sustained shield rep/sec amortised across reload windows for fueled
     *  reppers (paste-loaded AAR or cap-charge-loaded ASB). Equals
     *  `shieldRepairPerSecond` when no fuel-bound repper is contributing. */
    shieldRepairPerSecondSustained: number
    armorRepairAmount: number
    armorRepairDuration: number
    armorRepairPerSecond: number
    armorRepairPerSecondSustained: number
    hullRepairAmount: number
    hullRepairDuration: number
    hullRepairPerSecond: number
    hullRepairPerSecondSustained: number
    /** Peak passive shield regen (GJ/s ≡ HP/s for shields). */
    passiveShieldRegenPeak: number
}

interface LayerAccumulator {
    amountTotal: number
    perSecondTotal: number
    perSecondSustainedTotal: number
    cycleSecondsList: number[]
}

const ATTR_RELOAD_TIME = 1795
const ATTR_CAPACITY    = 38
const ATTR_VOLUME      = 161

export function computeTank(ctx: FitContext): TankRates {
    const acc: Record<'SHIELD' | 'ARMOR' | 'HULL', LayerAccumulator> = {
        SHIELD: emptyAcc(),
        ARMOR:  emptyAcc(),
        HULL:   emptyAcc(),
    }

    for (const m of ctx.modules) {
        if (m.state !== 'ACTIVE' && m.state !== 'OVERLOAD') continue
        for (const eid of m.effectIDs) {
            const repInfo = REPAIR_EFFECT_AMOUNT_ATTR[eid]
            if (!repInfo) continue
            const baseAmount = m.getFinal(repInfo.amountAttr, 0)
            if (baseAmount <= 0) continue
            let amount = baseAmount
            // AAR (effect 5275) loaded with Nanite Repair Paste triples
            // its per-cycle amount. Pyfa-parity, hardcoded constant.
            const fueled = PASTE_FUELED_REP_EFFECTS.has(eid)
                && m.charge?.typeID === NANITE_REPAIR_PASTE_TYPE_ID
            if (fueled) {
                amount *= ANCILLARY_REP_PASTE_MULTIPLIER
            }
            const durationMs = m.getFinal(73 /* duration attr id */, 0)
            if (durationMs <= 0) continue
            const cycleSeconds = durationMs / 1000
            acc[repInfo.layer].amountTotal += amount
            acc[repInfo.layer].perSecondTotal += amount / cycleSeconds
            acc[repInfo.layer].cycleSecondsList.push(cycleSeconds)

            // Sustained per-second amortises the fuel runtime: while paste
            // is loaded, the AAR reps at 3× for `chargesPerLoad` cycles,
            // then runs out and the module reloads. During the reload
            // window (typically 60 s) it produces 0 rep. Steady-state
            // rep/sec = (3 × base × charges) / (charges × cycleSec +
            // reloadSec). Unfueled / non-paste reps amortise at peak rate.
            if (fueled && m.charge) {
                const capacity = m.getFinal(ATTR_CAPACITY, 0)
                const chargeVol = m.charge.getFinal(ATTR_VOLUME, 1)
                const charges = chargeVol > 0 ? Math.floor(capacity / chargeVol) : 0
                const reloadMs = m.getFinal(ATTR_RELOAD_TIME, 60_000)  // AAR default 60 s
                const reloadSec = reloadMs / 1000
                if (charges > 0) {
                    const damagePerLoad = amount * charges
                    const timePerLoad = charges * cycleSeconds + reloadSec
                    acc[repInfo.layer].perSecondSustainedTotal += damagePerLoad / timePerLoad
                } else {
                    acc[repInfo.layer].perSecondSustainedTotal += amount / cycleSeconds
                }
            } else {
                acc[repInfo.layer].perSecondSustainedTotal += amount / cycleSeconds
            }
        }
    }

    // Passive shield regen: peak passive rate of the ship's shield recharge
    // curve, evaluated at 25% shield (the natural peak point).
    const ship = ctx.ship
    const shieldCap = ship.getFinal(ATTR.SHIELD_CAPACITY, 0)
    const shieldRechargeMs = ship.getFinal(ATTR.SHIELD_RECHARGE_RATE, 0)
    const passiveShieldRegenPeak = peakRecharge(shieldCap, shieldRechargeMs)

    return {
        shieldRepairAmount: acc.SHIELD.amountTotal,
        shieldRepairDuration: averageCycle(acc.SHIELD),
        shieldRepairPerSecond: acc.SHIELD.perSecondTotal,
        shieldRepairPerSecondSustained: acc.SHIELD.perSecondSustainedTotal,
        armorRepairAmount: acc.ARMOR.amountTotal,
        armorRepairDuration: averageCycle(acc.ARMOR),
        armorRepairPerSecond: acc.ARMOR.perSecondTotal,
        armorRepairPerSecondSustained: acc.ARMOR.perSecondSustainedTotal,
        hullRepairAmount: acc.HULL.amountTotal,
        hullRepairDuration: averageCycle(acc.HULL),
        hullRepairPerSecond: acc.HULL.perSecondTotal,
        hullRepairPerSecondSustained: acc.HULL.perSecondSustainedTotal,
        passiveShieldRegenPeak,
    }
}

function emptyAcc(): LayerAccumulator {
    return { amountTotal: 0, perSecondTotal: 0, perSecondSustainedTotal: 0, cycleSecondsList: [] }
}

function averageCycle(a: LayerAccumulator): number {
    if (a.cycleSecondsList.length === 0) return 0
    let sum = 0
    for (const v of a.cycleSecondsList) sum += v
    return sum / a.cycleSecondsList.length
}
