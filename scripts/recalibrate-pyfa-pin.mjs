/**
 * Recalibrate the differential-harness pyfa pin + known-differences registry.
 *
 * The accepted-differences list (test/diff/known-diffs.mjs) and the PYFA_REF pin
 * (.github/workflows/diff-parity.yml) are tied to ONE exact pyfa commit. When
 * you deliberately bump pyfa, both must move together — otherwise the registry
 * is calibrated against a different oracle than CI runs and either masks real
 * diffs or flags phantom ones.
 *
 * This script does the MECHANICAL half automatically; the human still classifies
 * any genuinely-new diff (a known-diff entry must be a proven non-bug, never a
 * silently-accepted regression).
 *
 * Procedure (deliberate pyfa bump):
 *   rm -rf .pyfa
 *   PYFA_REF=<new-commit> npm run diff:setup      # rebuild oracle at the new pin
 *   npm run diff:recalibrate                       # this script
 *   # → review every entry it marks "PENDING REVIEW", replace the reason with a
 *   #   real root cause (or, if it's a real bug, FIX the engine and re-run).
 *   npm run test:pyfa                              # must stay 662/0
 *   npm run diff                                    # must exit 0
 *
 * What it does:
 *   1. Reads the CURRENT .pyfa HEAD (the oracle you just set up) → the new pin.
 *   2. Runs the diff in --strict mode (every diff, ignoring the old registry).
 *   3. Diffs current-vs-old accepted set:
 *        KEPT    — same (ship,fitType,key): carry the old reason forward.
 *        ADDED   — new diff not previously accepted: write it with a loud
 *                  "PENDING REVIEW" reason for a human to classify.
 *        REMOVED — old entry no longer diffs: dropped (resolved).
 *   4. Rewrites test/diff/known-diffs.mjs and bumps PYFA_REF in diff-parity.yml.
 *   5. Prints the report; exits 1 if anything is PENDING REVIEW.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { KNOWN_DIFFS } from '../test/diff/known-diffs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PYFA = resolve(ROOT, '.pyfa')
const REGISTRY = resolve(ROOT, 'test/diff/known-diffs.mjs')
const WORKFLOW = resolve(ROOT, '.github/workflows/diff-parity.yml')
const PENDING = 'PENDING REVIEW — classify this diff (real bug → fix engine; pyfa quirk → write the root cause) before release'

const keyOf = (d) => `${d.ship}|${d.fitType}|${d.key}`

function pyfaHead() {
    try {
        return execFileSync('git', ['-C', PYFA, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
        console.error('[recalibrate] .pyfa not found — run `npm run diff:setup` first.')
        process.exit(2)
    }
}

function currentDiffs() {
    // --strict → every diff is reported (old registry ignored); --json → machine
    // output. --strict exits 1 whenever diffs exist, so execFileSync throws; the
    // JSON is still on the thrown error's stdout. Read it either way.
    let out
    try {
        out = execFileSync(process.execPath, [resolve(ROOT, 'test/diff/run-diff.mjs'), '--strict', '--json'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    } catch (e) {
        if (e.stdout) out = e.stdout
        else { console.error('[recalibrate] diff run failed:', e.stderr?.slice(-2000) ?? e.message); process.exit(2) }
    }
    return JSON.parse(out).diffs
}

function renderRegistry(entries, pin) {
    const head = `/**
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
 * Calibrated against pyfa commit: ${pin}
 * (kept in lock-step with PYFA_REF in .github/workflows/diff-parity.yml.)
 *
 * Matching is by (ship, fitType, statKey). A matched diff is ACCEPTED and does
 * not fail the run; ANY unlisted diff fails \`npm run diff\` (exit 1). Entries
 * marked "PENDING REVIEW" were added by the recalibration script at a pin bump
 * and MUST be classified (and their reason replaced) before release.
 *
 * Invariant: never regress \`npm run test:pyfa\` (662/0) to satisfy this harness.
 */

/** @typedef {{ ship: string, fitType: string, key: string, reason: string }} KnownDiff */

/** @type {KnownDiff[]} */
export const KNOWN_DIFFS = [
`
    const body = entries
        .slice()
        .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
        .map(e => `    { ship: ${JSON.stringify(e.ship)}, fitType: ${JSON.stringify(e.fitType)}, key: ${JSON.stringify(e.key)}, reason: ${JSON.stringify(e.reason)} },`)
        .join('\n')
    const tail = `
]

const _key = (d) => \`\${d.ship}|\${d.fitType}|\${d.key}\`
const _set = new Set(KNOWN_DIFFS.map(_key))
const _reason = new Map(KNOWN_DIFFS.map(d => [_key(d), d.reason]))

/** True if this diff is a documented, accepted difference. */
export function isKnownDiff(d) { return _set.has(_key(d)) }

/** The documented root cause for an accepted diff (or undefined). */
export function knownDiffReason(d) { return _reason.get(_key(d)) }
`
    return head + body + tail
}

function bumpWorkflowPin(pin) {
    let wf = readFileSync(WORKFLOW, 'utf8')
    const re = /(PYFA_REF:\s*)[0-9a-f]{7,40}/
    if (!re.test(wf)) { console.error('[recalibrate] could not find PYFA_REF in diff-parity.yml'); process.exit(2) }
    wf = wf.replace(re, `$1${pin}`)
    writeFileSync(WORKFLOW, wf)
}

// --- main ---
const pin = pyfaHead()
console.error(`[recalibrate] oracle pin (.pyfa HEAD): ${pin}`)
const diffs = currentDiffs()
const oldReason = new Map(KNOWN_DIFFS.map(d => [keyOf(d), d.reason]))
const currentKeys = new Set(diffs.map(keyOf))

const next = []
const added = [], kept = []
for (const d of diffs) {
    const k = keyOf(d)
    const reason = oldReason.has(k) && oldReason.get(k) !== PENDING ? oldReason.get(k) : PENDING
    const entry = { ship: d.ship, fitType: d.fitType, key: d.key, reason }
    next.push(entry)
    ;(oldReason.has(k) ? kept : added).push(entry)
}
const removed = KNOWN_DIFFS.filter(d => !currentKeys.has(keyOf(d)))

writeFileSync(REGISTRY, renderRegistry(next, pin))
bumpWorkflowPin(pin)

console.log(`\n=== recalibration vs pin ${pin.slice(0, 7)} ===`)
console.log(`  kept    : ${kept.length}`)
console.log(`  removed : ${removed.length}${removed.length ? ' (resolved — dropped)' : ''}`)
for (const d of removed) console.log(`      - ${d.ship} | ${d.fitType} | ${d.key}`)
console.log(`  added   : ${added.length}${added.length ? '  ← NEEDS HUMAN CLASSIFICATION' : ''}`)
for (const d of added) console.log(`      + ${d.ship} | ${d.fitType} | ${d.key}`)
console.log(`\nWrote ${next.length} entries to test/diff/known-diffs.mjs; PYFA_REF bumped in diff-parity.yml.`)
if (added.length) {
    console.log(`\n⚠  ${added.length} entr${added.length === 1 ? 'y is' : 'ies are'} PENDING REVIEW — classify each (real bug → fix the engine; pyfa quirk → write the root cause), then re-run.`)
    process.exit(1)
}
console.log('\n✅ No new diffs — registry + pin updated, nothing to classify.')
