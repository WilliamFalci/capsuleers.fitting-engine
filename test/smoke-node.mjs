/**
 * Batteries-included smoke: prove `eve-fit-engine/node` computes
 * from an EFT string with ZERO setup (bundled SDE, default All-V skills).
 */
import { computeFromEft } from '../dist/node.js'

const EFT = `[Rifter, Smoke Test]

200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S

1MN Afterburner II
Small Shield Extender II

Gyrostabilizer II
Gyrostabilizer II
`

let fails = 0
const check = (label, ok, val) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${val}`); if (!ok) fails++ }

const { fit, warnings, computed } = await computeFromEft(EFT)
const d = computed.derived

check('parsed ship = Rifter (587)', fit.shipTypeID === 587, fit.shipTypeID)
check('module lines parsed', fit.modules.length >= 5, `${fit.modules.length} modules`)
check('EHP > 0', d.defense.ehpTotalAgainstProfile > 0, Math.round(d.defense.ehpTotalAgainstProfile))
check('capacitor > 0', d.capacitor.capacity > 0, Math.round(d.capacitor.capacity))
check('velocity > 0 (AB fitted)', d.navigation.maxVelocity > 0, d.navigation.maxVelocity.toFixed(1))
check('weapon DPS > 0 (ammo loaded)', d.offense.totalDps > 0, d.offense.totalDps.toFixed(1))
if (warnings.length) console.log(`   (parse warnings: ${warnings.length} — ${warnings.map(w => w.text).join('; ')})`)

console.log(`\nBatteries-included smoke: ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
