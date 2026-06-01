/**
 * Autonomous EVE SDE acquisition for @capsuleers/eve-fit-engine.
 *
 * Downloads CCP's OFFICIAL JSONL Static Data Export and stages the .jsonl files
 * into `.sde-src/` (gitignored, ephemeral) for `build-bundle.ts` to consume.
 * No conversion needed — CCP ships the SDE already in the JSONL shape the
 * bundle builder expects.
 *
 * Mirrors the proven resolution logic of the capsuleers.app K8s init container:
 *   1. resolve the latest buildNumber from tranquility/latest.jsonl
 *   2. skip if data/.build already matches (unless --force)
 *   3. download eve-online-static-data-<build>-jsonl.zip, extract *.jsonl
 *   4. record the build number in .sde-src/.build (build-bundle stamps data/.build
 *      only after a successful build, so data/.build never runs ahead of data/)
 *
 *   node scripts/fetch-sde.mjs [--force]
 *
 * Exit: 0 ok (or skipped), 1 error. Prints "CHANGED" / "UNCHANGED" on the last
 * line so CI can branch on whether a rebuild+publish is warranted.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDE_SRC = path.join(ROOT, '.sde-src')
const DATA_BUILD = path.join(ROOT, 'data', '.build')
const BASE = 'https://developers.eveonline.com/static-data/tranquility'

async function readMaybe(p) { try { return (await readFile(p, 'utf8')).trim() } catch { return null } }

async function main() {
    const force = process.argv.includes('--force')

    // 1. latest buildNumber
    const latest = await fetch(`${BASE}/latest.jsonl`)
    if (!latest.ok) throw new Error(`latest.jsonl -> ${latest.status}`)
    const firstLine = (await latest.text()).trim().split('\n')[0] ?? ''
    const build = String(JSON.parse(firstLine).buildNumber ?? '')
    if (!build) throw new Error('could not parse buildNumber from latest.jsonl')
    console.log(`[fetch-sde] upstream build = ${build}`)

    // 2. skip if unchanged
    const local = await readMaybe(DATA_BUILD)
    console.log(`[fetch-sde] local data build = ${local ?? '<none>'}`)
    if (!force && local === build && existsSync(path.join(ROOT, 'data', 'manifest.json'))) {
        console.log('[fetch-sde] dataset already at this build — nothing to do')
        console.log('UNCHANGED')
        return
    }

    // 3. download + extract .jsonl
    const zipUrl = `${BASE}/eve-online-static-data-${build}-jsonl.zip`
    console.log(`[fetch-sde] downloading ${zipUrl}`)
    const zipRes = await fetch(zipUrl)
    if (!zipRes.ok) throw new Error(`zip -> ${zipRes.status}`)
    const buf = Buffer.from(await zipRes.arrayBuffer())
    console.log(`[fetch-sde] downloaded ${(buf.length / 1048576).toFixed(1)} MB, extracting...`)

    await rm(SDE_SRC, { recursive: true, force: true })
    await mkdir(SDE_SRC, { recursive: true })
    const zip = new AdmZip(buf)
    let n = 0
    for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.endsWith('.jsonl')) continue
        await writeFile(path.join(SDE_SRC, path.basename(e.entryName)), e.getData())
        n++
    }
    if (n === 0) throw new Error('no .jsonl entries found in the SDE zip')
    await writeFile(path.join(SDE_SRC, '.build'), build)
    console.log(`[fetch-sde] staged ${n} .jsonl files into .sde-src (build ${build})`)
    console.log('CHANGED')
}

main().catch((err) => { console.error('[fetch-sde]', err.message); process.exit(1) })
