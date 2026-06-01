# Release & wiring checklist

Everything in the package is built, tested (parity 631/0, coverage 0 silent) and
publish-verified (`npm publish --dry-run` → 906 kB tarball with dist/ + data/).
The steps below need **your npm + GitHub credentials** and so must be run by you.

## 0. Decide the npm scope (one-time)

The package name is `@capsuleers/eve-fit-engine`. The `@capsuleers` scope needs an
npm **org or user** called `capsuleers`. Pick one:

- **Create the org** (free for public packages): https://www.npmjs.com/org/create → `capsuleers`. Recommended.
- **Or rename** in `package.json` to an unscoped/own-scope name you control, e.g.
  `eve-fit-engine` (if free) or `@williamfalci/eve-fit-engine`. If you rename,
  also update the `@capsuleers/eve-fit-engine` import paths in `src/node.ts`
  docs/README and the app's consumer imports.

## 1. First publish (manual, one-time)

```bash
cd Capsuleers.FitEngine
npm login                       # your npm account
npm publish --access public     # runs prepublishOnly (typecheck + build)
```

After this, `npm view @capsuleers/eve-fit-engine version` → `0.1.0`.

> Subsequent data updates publish **automatically** via `.github/workflows/sde-refresh.yml`
> (it only publishes when the SDE actually changes + parity stays green).

## 2. Enable auto-publish CI (one-time)

1. Create an npm **automation token**: npmjs.com → Access Tokens → Generate → *Automation*.
2. Add it as a GitHub Actions secret on this repo:
   - GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `NPM_TOKEN`, Value: the token.
3. (Optional) Trigger `sde-refresh.yml` once via **Actions → sde-refresh → Run workflow**
   to validate the pipeline (on unchanged data it will say "up to date" and not publish).

## 3. Point capsuleers.app at the published package

In `Capsuleers.Site/package.json`, change the dependency:

```diff
- "@capsuleers/eve-fit-engine": "file:../Capsuleers.FitEngine",
+ "@capsuleers/eve-fit-engine": "^0.1.0",
```

Then `npm install` in the app. **Required before the Docker build** — the `file:`
spec does not resolve inside Docker (the sibling repo isn't in the build context).

## 4. Ship the app + deploy (same release)

The Dockerfile already bakes the package's `data/` into the image and the K8s
manifest already drops the old `build-fitting-bundle` init container + reads
`NUXT_FITTING_BUNDLE_OUT=/app/fitting-data`. Build the app image and apply the
manifest together so the removed init container and the new image land at once.

## Ongoing (hands-off)

- **EVE SDE update** → `sde-refresh.yml` (daily) rebuilds `data/` from CCP, runs
  parity/coverage, and auto-publishes a patch if green. Bump the app dependency
  + redeploy to pick it up.
- **Pyfa code change** → `pyfa-drift.yml` (weekly) opens an issue listing the
  changed effect IDs for a human to port (then parity gates the release).
