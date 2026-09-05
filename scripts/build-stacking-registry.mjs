/**
 * Generate the stacking-penalty registry from pyfa's own effect handlers.
 *
 * In EVE the stacking penalty is not a property of an ATTRIBUTE — it is a
 * property of the (effect, attribute) pair, and pyfa writes it one call at a
 * time: `boostItemAttr('damageMultiplier', …)` multiplies in full, while
 * `boostItemAttr('mass', …, stackingPenalties=True)` joins a penalised chain.
 * Measured against the pinned pyfa: of 2 799 attribute-boosting calls only 403
 * penalise, spread over 286 effects.
 *
 * Getting the granularity wrong in EITHER direction is visible:
 *   - too coarse (penalise every modifier sharing an attribute) chains bonuses
 *     pyfa keeps apart — a Rokh with a Microwarpdrive and a Micro Jump Drive
 *     read 6 335 m of signature radius against pyfa's 6 875;
 *   - too coarse the other way (penalise a whole effect because one of its
 *     calls does) breaks the Siege Module, whose turret damage bonus is
 *     unpenalised while its mass, shield and armour bonuses are penalised —
 *     a sieged Moros then reads 12 648 weapon DPS against pyfa's 13 161.
 *
 * Encoding, per effect id (attributes are ATTRIBUTE IDS, resolved from the raw
 * SDE table — the shipped bundle only carries published attributes, and some
 * penalised ones like `warpSpeedMultiplier` are not published):
 *   - `"attrId"`          — every call touching that attribute penalises.
 *   - `"receiver:attrId"` — only calls with that receiver penalise. Needed for
 *                           exactly four pairs, all of the same shape: the
 *                           Siege / Bastion modules slow the SHIP unpenalised
 *                           while penalising a module's or a charge's speed.
 *   - `"*"` / `"receiver:*"` — the attribute name is computed at runtime
 *                           (`'%sDamage' % type`), so it can't be pinned down;
 *                           the wildcard keeps those penalising.
 *
 *   npm run stacking:build             # rewrite src/stackingPenalised.ts
 *   npm run stacking:build -- --check  # fail if it would change
 *
 * Reads the pyfa checkout the diff oracle already pins (.pyfa), so the registry
 * and the oracle can never describe two different pyfa versions.
 */
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EFFECTS_PY = path.join(ROOT, '.pyfa', 'eos', 'effects.py')
const SDE_ATTRS = path.join(ROOT, '.sde-src', 'dogmaAttributes.jsonl')
const SDE_EFFECTS = path.join(ROOT, '.sde-src', 'dogmaEffects.jsonl')

/**
 * Corrections where pyfa's handler BODY doesn't describe the SDE effect of the
 * same id, so its penalty flag lands on an effect this engine never applies.
 *
 * Two exist today, and the cross-check below is what finds a third. pyfa's
 * Effect5998 (`freighterSMACapacityBonusO1`) boosts AGILITY and penalises it,
 * while the SDE's 5998 moves the maintenance-bay capacity and it is 6001 that
 * moves agility — the two bodies are transposed. Without the correction a
 * Bowhead's Inertial Stabilizer took the unpenalised first slot instead of the
 * second and the hull read 18.21 s of align time against pyfa's 18.81.
 *
 * `[sdeEffectId, attributeId, penaltyGroup]`.
 */
const OVERRIDES = [
    [6001, 70, 'default'],   // freighterAgilityBonus2O2 ← pyfa's Effect5998
]
const OUT = path.join(ROOT, 'src', 'stackingPenalised.ts')

/**
 * pyfa names attributes, the engine has ids — and the mapping must come from
 * the FULL SDE table, not from the shipped bundle: the bundle carries only
 * published attributes, and several penalised ones (`warpSpeedMultiplier`,
 * id 600) are unpublished. Keying the registry on names cost 32 real fits an
 * unpenalised warp-speed rig before this was moved to ids.
 */
async function attributeIds() {
    const byName = new Map()
    const rl = readline.createInterface({ input: createReadStream(SDE_ATTRS), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line.trim()) continue
        const a = JSON.parse(line)
        if (a.name) byName.set(a.name, a._key)
    }
    return byName
}

const CALLS = ['boostItemAttr', 'multiplyItemAttr', 'filteredItemBoost',
               'filteredChargeBoost', 'filteredItemMultiply', 'filteredChargeMultiply']
const CALL_RE = new RegExp(`(\\w+)\\.(${CALLS.join('|')})\\(`, 'g')

/** Split an argument list on top-level commas (lambdas carry their own). */
function splitArgs(text) {
    const args = []
    let depth = 0, cur = '', quote = null
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quote) { cur += ch; if (ch === quote && text[i - 1] !== '\\') quote = null; continue }
        if (ch === "'" || ch === '"') { quote = ch; cur += ch }
        else if ('([{'.includes(ch)) { depth++; cur += ch }
        else if (')]}'.includes(ch)) { depth--; cur += ch }
        else if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = '' }
        else cur += ch
    }
    if (cur.trim()) args.push(cur.trim())
    return args
}

/** Text inside the parens of the call whose '(' is at `open`. */
function callBody(text, open) {
    let depth = 0, quote = null
    for (let i = open; i < text.length; i++) {
        const ch = text[i]
        if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue }
        if (ch === "'" || ch === '"') quote = ch
        else if (ch === '(') depth++
        else if (ch === ')') { depth--; if (depth === 0) return text.slice(open + 1, i) }
    }
    return ''
}

/** Map pyfa's receiver expression + call name onto the engine's target kinds. */
function receiverOf(receiver, fn) {
    if (receiver === 'ship') return 'ship'
    if (receiver === 'drones') return 'drone'
    if (receiver === 'fighters') return 'fighter'
    if (receiver === 'character') return 'character'
    if (receiver === 'modules') return fn.startsWith('filteredCharge') ? 'charge' : 'module'
    return 'self'   // module / container / src / fit.extraAttributes …
}

/**
 * The source kinds pyfa EXEMPTS from an effect's penalty.
 *
 * Handlers guard the flag with the context they were invoked from, and every
 * form in effects.py names the exempt side — `penalized = False if 'skill' in
 * context …`, `penalties = 'ship' not in context`, or the if/else spelling.
 * Missing the `'ship'` variant made the Badger's own agility bonus join the
 * chain of its Nanofibers and Inertial Stabilizers, costing 13.7 % of its
 * agility. (One handler guards on `layer == 'hull'` rather than a context;
 * it names nothing here and stays penalising.)
 */
function exemptContexts(body) {
    const m = /stackingPenalties=(?!True\b|False\b)(\w+)/.exec(body)
    if (!m) return []
    const varName = m[1]
    const lines = body.split('\n').filter((l, i, all) =>
        new RegExp(`\\b${varName}\\s*=`).test(l)
        // the if/else spelling puts the condition on the preceding `if` line
        || (/^\s*if\s.*:\s*$/.test(l) && all.slice(i + 1, i + 3).some(n => new RegExp(`\\b${varName}\\s*=`).test(n))))
    const names = new Set()
    for (const l of lines) {
        for (const c of l.matchAll(/'(\w+)'\s+(?:not\s+)?in\s+context/g)) names.add(c[1])
    }
    return [...names].sort()
}

function classify(src) {
    const parts = src.split(/\nclass (Effect\d+)\(BaseEffect\):/)
    /** @type {Map<number, Map<string, Set<{recv:string,pen:boolean}>>>} */
    const perEffect = new Map()
    let calls = 0, penalisedCalls = 0
    for (let i = 1; i < parts.length; i += 2) {
        const id = Number(parts[i].slice('Effect'.length))
        const body = parts[i + 1] ?? ''
        const exempt = exemptContexts(body)
        CALL_RE.lastIndex = 0
        let m
        while ((m = CALL_RE.exec(body)) !== null) {
            const [, receiver, fn] = m
            const inner = callBody(body, m.index + m[0].length - 1)
            if (!inner) continue
            calls++
            const args = splitArgs(inner)
            const pen = /stackingPenalties=True\b/.test(inner)
                || /stackingPenalties=(?!True\b|False\b)\w+/.test(inner)
            if (pen) penalisedCalls++
            // pyfa chains are keyed by (attribute, penaltyGroup); an explicit
            // group forms an INDEPENDENT chain. The T3D Defense Mode uses one
            // ('postDiv'), which is why its resist bonus doesn't compete with a
            // hardener's — without honouring it, a Svipul's EHP fell 3.6 %
            // below pyfa's.
            const groupMatch = /penaltyGroup='([A-Za-z]+)'/.exec(inner)
            const group = groupMatch ? groupMatch[1] : 'default'
            const attrArg = args[fn.startsWith('filtered') ? 1 : 0] ?? ''
            const lit = /^'([A-Za-z0-9_]+)'$/.exec(attrArg)
            const attr = lit ? lit[1] : '*'
            if (!perEffect.has(id)) perEffect.set(id, new Map())
            const byAttr = perEffect.get(id)
            if (!byAttr.has(attr)) byAttr.set(attr, [])
            byAttr.get(attr).push({ recv: receiverOf(receiver, fn), pen, group, exempt })
        }
    }

    return { perEffect, calls, penalisedCalls }
}

/** Turn the per-effect analysis into id-keyed registry rows. */
function toRegistry(perEffect, attrIds) {
    const registry = new Map()
    const unresolved = new Set()
    let ambiguous = 0
    for (const [id, byAttr] of perEffect) {
        const keys = new Set()
        for (const [attr, uses] of byAttr) {
            const pen = uses.filter(u => u.pen)
            if (!pen.length) continue
            let key = attr
            if (attr !== '*') {
                const aid = attrIds.get(attr)
                if (aid === undefined) { unresolved.add(attr); continue }
                key = String(aid)
            }
            const suffix = (u) => u.exempt.length ? `!${u.exempt.join('+')}` : ''
            if (pen.length === uses.length && new Set(pen.map(u => u.group)).size === 1) {
                keys.add(`${key}#${pen[0].group}${suffix(pen[0])}`)
            } else {
                ambiguous++
                for (const u of pen) keys.add(`${u.recv}:${key}#${u.group}${suffix(u)}`)
            }
        }
        if (keys.size) registry.set(id, [...keys].sort())
    }
    return { registry, ambiguous, unresolved }
}

/** SDE effect id → the attribute ids its modifierInfo actually touches. */
async function sdeEffectAttributes() {
    const byEffect = new Map()
    const rl = readline.createInterface({ input: createReadStream(SDE_EFFECTS), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line.trim()) continue
        const e = JSON.parse(line)
        const ids = new Set()
        for (const m of e.modifierInfo ?? []) {
            if (m.modifiedAttributeID != null) ids.add(m.modifiedAttributeID)
        }
        byEffect.set(e._key, ids)
    }
    return byEffect
}

async function main() {
    const src = await readFile(EFFECTS_PY, 'utf8')
    const attrIds = await attributeIds()
    const { perEffect, calls, penalisedCalls } = classify(src)
    const { registry, ambiguous, unresolved } = toRegistry(perEffect, attrIds)
    // Cross-check every key against the SDE: a penalty pinned to an attribute
    // the effect doesn't modify means pyfa's handler and the SDE effect have
    // drifted apart, and the flag will never fire. Reported, never silent.
    const sdeAttrs = await sdeEffectAttributes()
    const mismatched = []
    for (const [eid, keys] of registry) {
        const known = sdeAttrs.get(eid)
        if (!known || known.size === 0) continue
        for (const key of keys) {
            const attr = key.split('!')[0].split('#')[0].split(':').pop()
            if (attr === '*') continue
            if (!known.has(Number(attr))) mismatched.push(`${eid}→attr ${attr}`)
        }
    }
    if (mismatched.length) {
        console.warn(`[stacking] ${mismatched.length} key(s) pin a penalty to an attribute the SDE effect does not modify (pyfa handler drift): ${mismatched.join(', ')}`)
        console.warn('[stacking]   → if one of them matters, add an OVERRIDES row mapping it onto the SDE effect that does.')
    }
    for (const [eid, attr, group] of OVERRIDES) {
        const keys = new Set(registry.get(eid) ?? [])
        keys.add(`${attr}#${group}`)
        registry.set(eid, [...keys].sort())
    }

    if (unresolved.size) {
        console.warn(`[stacking] ${unresolved.size} attribute name(s) absent from the SDE, skipped: ${[...unresolved].slice(0, 8).join(', ')}`)
    }
    const ids = [...registry.keys()].sort((a, b) => a - b)
    const rows = ids.map(id => `    [${id}, [${registry.get(id).map(k => `'${k}'`).join(', ')}]],`).join('\n')

    const out = `/**
 * Which (effect, attribute) pairs impose a STACKING PENALTY — GENERATED file,
 * do not edit by hand. Regenerate with \`npm run stacking:build\`, which reads
 * the pinned pyfa checkout under .pyfa so this registry and the diff oracle can
 * never describe two different pyfa versions.
 *
 * The penalty is a property of the CALL, not of the attribute: pyfa writes
 * \`stackingPenalties=True\` one boost at a time, and of its ${calls} attribute-boosting
 * calls only ${penalisedCalls} penalise, across ${ids.length} effects. Both coarser models are
 * wrong and both were measured: penalising everything that shares an attribute
 * made a Rokh with a Microwarpdrive and a Micro Jump Drive read 6 335 m of
 * signature radius against pyfa's 6 875, while penalising a whole effect because
 * one of its calls does made a sieged Moros read 12 648 weapon DPS against
 * 13 161 — the Siege Module penalises its mass and repair bonuses but NOT its
 * turret damage bonus.
 *
 * Keys are attribute NAMES; ${ambiguous} of them are receiver-qualified
 * (\`ship:maxVelocity\`) because the same effect penalises that attribute on one
 * target and not on another. \`*\` stands for an attribute name pyfa computes at
 * runtime (\`'%sDamage' % type\`), which cannot be pinned to one name.
 */

/**
 * effect id → penalised keys, each \`[receiver:]attrId#penaltyGroup\`
 * (\`*\` where pyfa computes the attribute name at runtime).
 */
export const STACKING_PENALISED: ReadonlyMap<number, readonly string[]> = new Map([
${rows}
])

/** Receiver classes used to qualify an ambiguous key. */
export type PenaltyReceiver = 'ship' | 'module' | 'charge' | 'drone' | 'fighter' | 'character' | 'self'

/** pyfa's \`context\` names, as the engine's source kinds. */
const CONTEXT_KIND: Readonly<Record<string, readonly string[]>> = {
    skill: ['skill', 'character'],
    ship: ['ship'],
    implant: ['implant'],
    booster: ['booster'],
    module: ['module'],
    drone: ['drone'],
    fighter: ['fighter'],
    subsystem: ['subsystem'],
    mode: ['mode'],
}

/**
 * The pyfa penalty GROUP this effect uses for this attribute on this target, or
 * null when it doesn't penalise at all — the common case (1 900+ of pyfa's
 * boosting effects multiply in full).
 *
 * Chains are per (attribute, group): an effect with an explicit group forms its
 * own chain and does not compete with the \`default\` one.
 */
export function stackPenaltyGroup(
    effectID: number,
    attributeID: number | undefined,
    receiver: PenaltyReceiver,
    sourceKind: string,
): string | null {
    const keys = STACKING_PENALISED.get(effectID)
    if (!keys) return null
    const id = attributeID === undefined ? null : String(attributeID)
    for (const key of keys) {
        const bang = key.indexOf('!')
        const exempt = bang < 0 ? [] : key.slice(bang + 1).split('+')
        const head = bang < 0 ? key : key.slice(0, bang)
        const hash = head.lastIndexOf('#')
        const group = head.slice(hash + 1)
        const target = head.slice(0, hash)
        const colon = target.indexOf(':')
        const recv = colon < 0 ? null : target.slice(0, colon)
        const attr = colon < 0 ? target : target.slice(colon + 1)
        if (recv !== null && recv !== receiver) continue
        if (attr !== '*' && (id === null || attr !== id)) continue
        if (exempt.some(c => (CONTEXT_KIND[c] ?? []).includes(sourceKind))) return null
        return group
    }
    return null
}
`
    if (process.argv.includes('--check')) {
        const cur = await readFile(OUT, 'utf8').catch(() => '')
        if (cur !== out) { console.error('[stacking] registry is stale — run `npm run stacking:build`'); process.exit(2) }
        console.log(`[stacking] up to date (${ids.length} effects, ${penalisedCalls} penalised calls)`)
        return
    }
    await writeFile(OUT, out)
    console.log(`[stacking] wrote ${path.relative(ROOT, OUT)} — ${penalisedCalls}/${calls} calls penalise across ${ids.length} effects (${ambiguous} receiver-qualified)`)
}

main().catch(e => { console.error('[stacking]', e); process.exit(1) })
