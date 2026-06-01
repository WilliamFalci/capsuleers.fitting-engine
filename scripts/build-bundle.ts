/**
 * Build a hashed fitting-data bundle from the SDE JSONL files.
 *
 * Output layout:
 *   public/fitting-data/
 *     manifest.json              ← always at root, points to the active version
 *     v{contentHash}/
 *       attributes.json
 *       units.json
 *       effects.json
 *       meta-groups.json
 *       categories.json
 *       groups.json
 *       clone-grades.json
 *       dbuff-collections.json
 *       dynamic-attributes.json
 *       types/
 *         ships.json
 *         modules.json
 *         charges.json
 *         drones.json
 *         fighters.json
 *         implants.json
 *         subsystems.json
 *         skills.json
 *
 * The hash is a streaming SHA-256 over the actual content of every relevant
 * SDE file (plus this script's source). Regenerating with byte-identical
 * SDE input is a no-op even if mtimes have been touched.
 *
 * Run via: npx tsx scripts/build-fitting-bundle.ts
 * Wired into npm prebuild + predev.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ESM equivalent of __dirname (the project sets "type": "module" in
// package.json, so the CommonJS globals aren't available).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')
// SDE source: the JSONL files staged by `scripts/fetch-sde.mjs` (CCP's
// official JSONL SDE, downloaded into .sde-src/, gitignored). Override with
// NUXT_SDE_ROOT to point at an existing JSONL dir.
const SDE_ROOT = process.env.NUXT_SDE_ROOT
    ? path.resolve(process.env.NUXT_SDE_ROOT)
    : path.resolve(PROJECT_ROOT, '.sde-src')
// Output: the package's bundled dataset (data/), shipped in the npm tarball
// and served by consumers via `loadBundledDataset()` / BUNDLED_DATA_DIR.
const OUTPUT_ROOT = process.env.NUXT_FITTING_BUNDLE_OUT
    ? path.resolve(process.env.NUXT_FITTING_BUNDLE_OUT)
    : path.resolve(PROJECT_ROOT, 'data')

// SDE files that feed the fitting bundle. Map files (stargates / planets /
// etc.) are intentionally excluded — they don't affect fits.
const SOURCE_FILES = [
    'types.jsonl',
    'typeDogma.jsonl',
    'dogmaAttributes.jsonl',
    'dogmaEffects.jsonl',
    'dogmaUnits.jsonl',
    'categories.jsonl',
    'groups.jsonl',
    'metaGroups.jsonl',
    'marketGroups.jsonl',
    'cloneGrades.jsonl',
    'dbuffCollections.jsonl',
    'dynamicItemAttributes.jsonl',
] as const

// Categories surfaced in the fitting tool. Filter applied to types.jsonl
// so unrelated content (planetary, NPC bookmarks, etc.) doesn't bloat the
// bundle. Upwell structures (cat 65) + Standup modules (cat 66) are
// included so the existing `structureModuleEffect*` projection-EWAR
// handlers (effect IDs 6216, 6682-6686) have input to fire on.
const FITTING_CATEGORIES = {
    SHIP: 6,
    MODULE: 7,
    CHARGE: 8,
    SKILL: 16,
    MUTAPLASMID: 17,  // Decayed / Gravid / Unstable mutator items the
                      // editor lists per-module via `dynamicAttributes`
    DRONE: 18,
    IMPLANT: 20,  // includes boosters (group split discriminates at runtime)
    SUBSYSTEM: 32,
    STRUCTURE: 65,         // Upwell structures (Astrahus, Raitaru, Fortizar, …)
    STRUCTURE_MODULE: 66,  // Standup modules + service modules + structure rigs
    FIGHTER: 87,
} as const

const CATEGORY_TO_BUCKET: Record<number, keyof typeof OUTPUT_TYPE_FILES> = {
    [FITTING_CATEGORIES.SHIP]: 'ships',
    [FITTING_CATEGORIES.MODULE]: 'modules',
    [FITTING_CATEGORIES.CHARGE]: 'charges',
    [FITTING_CATEGORIES.SKILL]: 'skills',
    [FITTING_CATEGORIES.MUTAPLASMID]: 'mutaplasmids',
    [FITTING_CATEGORIES.DRONE]: 'drones',
    [FITTING_CATEGORIES.IMPLANT]: 'implants',
    [FITTING_CATEGORIES.SUBSYSTEM]: 'subsystems',
    [FITTING_CATEGORIES.FIGHTER]: 'fighters',
    [FITTING_CATEGORIES.STRUCTURE]: 'structures',
    [FITTING_CATEGORIES.STRUCTURE_MODULE]: 'structureModules',
}

/** Effect Beacon group (920, category 2 = Celestial). Surfaced as the
 *  `systemEffects` bucket in the bundle so the fitting tool can render
 *  Incursion / Wormhole / Triglavian / Drifter system effects without
 *  pulling the entire Celestial category. */
const EFFECT_BEACON_GROUP_ID = 920

/** Tactical Destroyer mode group (1306, category 7 = Module). Mode types
 *  (Defense / Propulsion / Sharpshooter) are published=false in the SDE
 *  but every T3D fit references one as `modeTypeID`, so they must be in
 *  the bundle for `dataset.getType(modeTypeID)` to resolve. */
const T3D_MODE_GROUP_ID = 1306

/** Civilian rookie-ship turret weapons (Pulse Laser / Autocannon / Railgun /
 *  Electron Blaster) are `published=false` in the SDE but DO appear on
 *  rookie ships and in legitimate Pyfa fits / screenshots. Bundle them so
 *  fits referencing them resolve and contribute their (small) cap drain.
 *  The Civilian Gatling Railgun's 0.5 GJ/s drain is exactly the difference
 *  between matching Pyfa's Arazu cap-stable % and a 4 pp gap. The other
 *  three civilian items in EVE (Stasis Webifier, Shield Boosters, etc.)
 *  are already `published=true` in the SDE so don't need a whitelist. */
const CIVILIAN_TYPE_IDS = new Set<number>([
    3634,   // Civilian Gatling Pulse Laser
    3636,   // Civilian Gatling Autocannon
    3638,   // Civilian Gatling Railgun
    3640,   // Civilian Light Electron Blaster
])

const OUTPUT_TYPE_FILES = {
    ships: 'types/ships.json',
    modules: 'types/modules.json',
    charges: 'types/charges.json',
    drones: 'types/drones.json',
    fighters: 'types/fighters.json',
    implants: 'types/implants.json',
    subsystems: 'types/subsystems.json',
    skills: 'types/skills.json',
    systemEffects: 'types/system-effects.json',
    structures: 'types/structures.json',
    structureModules: 'types/structure-modules.json',
    mutaplasmids: 'types/mutaplasmids.json',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* streamJsonl<T = any>(filePath: string): AsyncGenerator<T> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    try {
        for await (const line of rl) {
            if (!line) continue
            try {
                yield JSON.parse(line) as T
            } catch {
                /* skip malformed */
            }
        }
    } finally {
        rl.close()
        stream.destroy()
    }
}

function pickLocale(map: any, langs = ['en']): string | undefined {
    if (!map || typeof map !== 'object') return undefined
    for (const lang of langs) {
        if (typeof map[lang] === 'string') return map[lang]
    }
    return undefined
}

// Compute the bundle version hash from the *content* of every relevant SDE
// file plus the build script's own source. Streams each file through SHA-256
// so identical bytes always produce the same hash regardless of mtime/ctime
// (a `git checkout` or a re-extracted SDE that touches files without changing
// content must NOT invalidate the bundle). The script source is hashed by
// content too so that any change to the build logic (e.g. adding a new output
// bucket) forces a regeneration even when the SDE itself hasn't changed.
async function computeContentHash(): Promise<string> {
    const h = createHash('sha256')
    for (const file of SOURCE_FILES) {
        const fp = path.join(SDE_ROOT, file)
        if (!fs.existsSync(fp)) {
            throw new Error(`SDE file missing: ${fp}`)
        }
        // Include the filename in the digest so reordering / renaming files
        // is detected even if their bytes are identical.
        h.update(`\nfile:${file}\n`)
        await new Promise<void>((resolve, reject) => {
            const stream = fs.createReadStream(fp)
            stream.on('data', chunk => h.update(chunk as Buffer))
            stream.on('end', resolve)
            stream.on('error', reject)
        })
    }
    h.update('\nscript:\n')
    h.update(fs.readFileSync(fileURLToPath(import.meta.url)))
    return h.digest('hex').slice(0, 12)
}

// Defensive integrity check: make sure every file the manifest claims to have
// produced is actually on disk. Catches the case where a user manually deletes
// a file inside the version dir, or where a previous build was interrupted
// after writing the manifest but before flushing every output. Returns the
// list of missing files (empty array means the bundle is intact).
function findMissingFiles(versionDir: string, manifest: any): string[] {
    if (!manifest || typeof manifest.files !== 'object') return []
    const missing: string[] = []
    for (const relativePath of Object.keys(manifest.files)) {
        const fp = path.join(versionDir, relativePath)
        if (!fs.existsSync(fp)) missing.push(relativePath)
    }
    return missing
}

function ensureDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
}

function writeJson(file: string, data: unknown) {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

interface BuildContext {
    versionDir: string
    written: Array<{ path: string; bytes: number; entries: number }>
}

async function buildAttributes(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const a of streamJsonl<any>(path.join(SDE_ROOT, 'dogmaAttributes.jsonl'))) {
        if (!a.published) continue
        out[a._key] = {
            id: a._key,
            name: a.name,
            displayName: pickLocale(a.displayName),
            unitID: a.unitID,
            iconID: a.iconID,
            defaultValue: a.defaultValue ?? 0,
            highIsGood: !!a.highIsGood,
            stackable: !!a.stackable,
            attributeCategoryID: a.attributeCategoryID,
            dataType: a.dataType,
        }
        count++
    }
    write(ctx, 'attributes.json', out, count)
}

async function buildUnits(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const u of streamJsonl<any>(path.join(SDE_ROOT, 'dogmaUnits.jsonl'))) {
        out[u._key] = {
            id: u._key,
            name: u.name,
            displayName: pickLocale(u.displayName),
        }
        count++
    }
    write(ctx, 'units.json', out, count)
}

async function buildEffects(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const e of streamJsonl<any>(path.join(SDE_ROOT, 'dogmaEffects.jsonl'))) {
        // Keep ALL effects, not just published, because typeDogma references
        // unpublished effects that still affect fits (slot type effects in
        // particular have published=false historically).
        out[e._key] = {
            id: e._key,
            name: e.name,
            displayName: pickLocale(e.displayName),
            effectCategoryID: e.effectCategoryID,
            isOffensive: !!e.isOffensive,
            isAssistance: !!e.isAssistance,
            isWarpSafe: !!e.isWarpSafe,
            durationAttributeID: e.durationAttributeID,
            dischargeAttributeID: e.dischargeAttributeID,
            rangeAttributeID: e.rangeAttributeID,
            falloffAttributeID: e.falloffAttributeID,
            trackingSpeedAttributeID: e.trackingSpeedAttributeID,
            fittingUsageChanceAttributeID: e.fittingUsageChanceAttributeID,
            resistanceAttributeID: e.resistanceAttributeID,
            distribution: e.distribution,
            propulsionChance: !!e.propulsionChance,
            electronicChance: !!e.electronicChance,
            rangeChance: !!e.rangeChance,
            disallowAutoRepeat: !!e.disallowAutoRepeat,
            guid: e.guid,
            modifierInfo: Array.isArray(e.modifierInfo) ? e.modifierInfo : [],
        }
        count++
    }
    write(ctx, 'effects.json', out, count)
}

async function buildMetaGroups(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const m of streamJsonl<any>(path.join(SDE_ROOT, 'metaGroups.jsonl'))) {
        out[m._key] = {
            id: m._key,
            name: pickLocale(m.name),
            color: m.color,
            iconID: m.iconID,
        }
        count++
    }
    write(ctx, 'meta-groups.json', out, count)
}

async function buildCategories(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const c of streamJsonl<any>(path.join(SDE_ROOT, 'categories.jsonl'))) {
        if (!c.published) continue
        out[c._key] = { id: c._key, name: pickLocale(c.name) }
        count++
    }
    write(ctx, 'categories.json', out, count)
}

async function buildGroups(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const g of streamJsonl<any>(path.join(SDE_ROOT, 'groups.jsonl'))) {
        if (!g.published) continue
        out[g._key] = {
            id: g._key,
            categoryID: g.categoryID,
            name: pickLocale(g.name),
        }
        count++
    }
    write(ctx, 'groups.json', out, count)
}

async function buildMarketGroups(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const g of streamJsonl<any>(path.join(SDE_ROOT, 'marketGroups.jsonl'))) {
        out[g._key] = {
            id: g._key,
            name: pickLocale(g.name),
            parentGroupID: g.parentGroupID,
            iconID: g.iconID,
            hasTypes: !!g.hasTypes,
        }
        count++
    }
    write(ctx, 'market-groups.json', out, count)
}

async function buildCloneGrades(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const c of streamJsonl<any>(path.join(SDE_ROOT, 'cloneGrades.jsonl'))) {
        out[c._key] = { id: c._key, name: c.name, skills: c.skills }
        count++
    }
    write(ctx, 'clone-grades.json', out, count)
}

async function buildDbuffCollections(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const d of streamJsonl<any>(path.join(SDE_ROOT, 'dbuffCollections.jsonl'))) {
        out[d._key] = {
            id: d._key,
            aggregateMode: d.aggregateMode,
            operationName: d.operationName,
            displayName: pickLocale(d.displayName),
            showOutputValueInUI: d.showOutputValueInUI,
            itemModifiers: d.itemModifiers ?? [],
            locationModifiers: d.locationModifiers ?? [],
            locationGroupModifiers: d.locationGroupModifiers ?? [],
            locationRequiredSkillModifiers: d.locationRequiredSkillModifiers ?? [],
        }
        count++
    }
    write(ctx, 'dbuff-collections.json', out, count)
}

async function buildDynamicAttributes(ctx: BuildContext) {
    const out: Record<number, any> = {}
    let count = 0
    for await (const d of streamJsonl<any>(path.join(SDE_ROOT, 'dynamicItemAttributes.jsonl'))) {
        out[d._key] = {
            id: d._key,
            attributeIDs: Array.isArray(d.attributeIDs)
                ? d.attributeIDs.map((a: any) => ({ id: a._key, min: a.min, max: a.max }))
                : [],
            inputOutputMapping: d.inputOutputMapping ?? [],
        }
        count++
    }
    write(ctx, 'dynamic-attributes.json', out, count)
}

// First pass: index every published type's groupID + minimal metadata.
async function buildTypeIndex(): Promise<Map<number, { groupID: number; entry: any }>> {
    // Need groups.jsonl loaded first to map groupID → categoryID
    const groupToCat = new Map<number, number>()
    for await (const g of streamJsonl<any>(path.join(SDE_ROOT, 'groups.jsonl'))) {
        groupToCat.set(g._key, g.categoryID)
    }

    const targetCategories = new Set(Object.values(FITTING_CATEGORIES))
    const result = new Map<number, { groupID: number; entry: any }>()
    for await (const t of streamJsonl<any>(path.join(SDE_ROOT, 'types.jsonl'))) {
        const isT3DMode = t.groupID === T3D_MODE_GROUP_ID
        const isCivilian = CIVILIAN_TYPE_IDS.has(t._key)
        if (!t.published && !isT3DMode && !isCivilian) continue
        const cat = groupToCat.get(t.groupID)
        const isEffectBeacon = t.groupID === EFFECT_BEACON_GROUP_ID
        if (!isEffectBeacon && (cat === undefined || !targetCategories.has(cat))) continue
        result.set(t._key, {
            groupID: t.groupID,
            entry: {
                id: t._key,
                name: pickLocale(t.name),
                groupID: t.groupID,
                categoryID: cat,
                marketGroupID: t.marketGroupID,
                iconID: t.iconID,
                metaGroupID: t.metaGroupID,
                metaLevel: t.metaLevel,
                variationParentTypeID: t.variationParentTypeID,
                mass: t.mass,
                volume: t.volume,
                capacity: t.capacity,
                portionSize: t.portionSize,
                basePrice: t.basePrice,
                // Dogma fields filled in pass 2.
                attributes: [] as Array<{ id: number; v: number }>,
                effects: [] as Array<{ id: number; def: 0 | 1 }>,
            },
        })
    }
    return result
}

// Second pass: attach typeDogma (attributes + effects) to every relevant type.
async function attachTypeDogma(types: Map<number, { groupID: number; entry: any }>): Promise<void> {
    for await (const td of streamJsonl<any>(path.join(SDE_ROOT, 'typeDogma.jsonl'))) {
        const ref = types.get(td._key)
        if (!ref) continue
        if (Array.isArray(td.dogmaAttributes)) {
            ref.entry.attributes = td.dogmaAttributes.map((a: any) => ({
                id: a.attributeID,
                v: a.value,
            }))
        }
        if (Array.isArray(td.dogmaEffects)) {
            ref.entry.effects = td.dogmaEffects.map((e: any) => ({
                id: e.effectID,
                def: e.isDefault ? 1 : 0,
            }))
        }
    }
}

async function buildTypes(ctx: BuildContext) {
    const types = await buildTypeIndex()
    await attachTypeDogma(types)

    // Bucket by category.
    const buckets: Record<keyof typeof OUTPUT_TYPE_FILES, Record<number, any>> = {
        ships: {}, modules: {}, charges: {}, drones: {}, fighters: {},
        implants: {}, subsystems: {}, skills: {}, systemEffects: {},
        structures: {}, structureModules: {}, mutaplasmids: {},
    }
    for (const [id, ref] of types) {
        if (ref.groupID === EFFECT_BEACON_GROUP_ID) {
            buckets.systemEffects[id] = ref.entry
            continue
        }
        const bucket = CATEGORY_TO_BUCKET[ref.entry.categoryID]
        if (!bucket) continue
        buckets[bucket][id] = ref.entry
    }
    for (const [bucket, file] of Object.entries(OUTPUT_TYPE_FILES)) {
        const data = buckets[bucket as keyof typeof buckets]
        write(ctx, file, data, Object.keys(data).length)
    }
}

function write(ctx: BuildContext, relativePath: string, data: any, entries: number) {
    const fullPath = path.join(ctx.versionDir, relativePath)
    writeJson(fullPath, data)
    const bytes = fs.statSync(fullPath).size
    ctx.written.push({ path: relativePath, bytes, entries })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Record the upstream SDE build number alongside the dataset, but only after a
 *  successful build, so OUTPUT_ROOT/.build never runs ahead of the data. The
 *  source stamp is written by scripts/fetch-sde.mjs into SDE_ROOT/.build. */
function stampBuild(): void {
    const src = path.join(SDE_ROOT, '.build')
    if (!fs.existsSync(src)) return
    try { fs.writeFileSync(path.join(OUTPUT_ROOT, '.build'), fs.readFileSync(src, 'utf-8').trim()) } catch { /* best effort */ }
}

async function main() {
    const startedAt = Date.now()
    const hash = await computeContentHash()
    const versionDir = path.join(OUTPUT_ROOT, `v${hash}`)
    const manifestPath = path.join(OUTPUT_ROOT, 'manifest.json')

    // Idempotency: if same hash already exists AND manifest points at it AND
    // every declared output file is still on disk, skip the regen. The
    // file-existence check is the safety net for partially-deleted bundles
    // (e.g. a user `rm`-ing a single json or an interrupted previous build).
    if (fs.existsSync(versionDir) && fs.existsSync(manifestPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
            if (existing?.version === hash) {
                const missing = findMissingFiles(versionDir, existing)
                if (missing.length === 0) {
                    console.log(`[fitting-bundle] up to date (v${hash}) — skip`)
                    stampBuild()
                    return
                }
                console.log(
                    `[fitting-bundle] v${hash} incomplete (${missing.length} files missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}) — rebuilding`,
                )
            }
        } catch { /* manifest unreadable, regenerate */ }
    }

    console.log(`[fitting-bundle] building v${hash} from ${SDE_ROOT}`)
    ensureDir(versionDir)
    const ctx: BuildContext = { versionDir, written: [] }

    // Sequential: each step only touches its own files; running in parallel
    // would just contend on filesystem reads of the same large SDE. The whole
    // build is ~10-30s on warm cache.
    await buildAttributes(ctx)
    await buildUnits(ctx)
    await buildEffects(ctx)
    await buildMetaGroups(ctx)
    await buildCategories(ctx)
    await buildGroups(ctx)
    await buildMarketGroups(ctx)
    await buildCloneGrades(ctx)
    await buildDbuffCollections(ctx)
    await buildDynamicAttributes(ctx)
    await buildTypes(ctx)

    const totalBytes = ctx.written.reduce((sum, w) => sum + w.bytes, 0)
    const manifest = {
        version: hash,
        builtAt: new Date().toISOString(),
        totalBytes,
        files: Object.fromEntries(
            ctx.written.map(w => [w.path, { bytes: w.bytes, entries: w.entries }]),
        ),
    }
    writeJson(manifestPath, manifest)
    stampBuild()

    const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[fitting-bundle] v${hash} written → ${(totalBytes / 1024 / 1024).toFixed(1)} MB across ${ctx.written.length} files in ${duration}s`)

    // Keep only the active version: this is a package that ships a single
    // bundle (manifest points at one v<hash>). Unlike a live HTTP server, there
    // are no in-flight requests pinned to an old hash, so 1 keeps the npm
    // tarball lean.
    pruneOldVersions(hash, 1)
}

function pruneOldVersions(currentHash: string, keep: number) {
    if (!fs.existsSync(OUTPUT_ROOT)) return
    const versionDirs = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('v'))
        .map(d => ({
            name: d.name,
            mtime: fs.statSync(path.join(OUTPUT_ROOT, d.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    const stale = versionDirs.slice(keep).filter(d => d.name !== `v${currentHash}`)
    for (const s of stale) {
        const dir = path.join(OUTPUT_ROOT, s.name)
        fs.rmSync(dir, { recursive: true, force: true })
        console.log(`[fitting-bundle] pruned ${s.name}`)
    }
}

main().catch(err => {
    console.error('[fitting-bundle] FAILED:', err)
    process.exit(1)
})
