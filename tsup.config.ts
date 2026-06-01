import { defineConfig } from 'tsup'

export default defineConfig({
    // Two entries:
    //  - index: environment-free engine (browser + node), dataset injected.
    //  - node:  batteries-included Node loader over the bundled SDE in data/.
    entry: ['src/index.ts', 'src/node.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: false,
    treeshake: true,
    target: 'es2020',
    // shims: inject `import.meta.url` into the CJS output so the node loader can
    // resolve the bundled data/ dir relative to the module in both formats.
    shims: true,
    // No external runtime deps: the engine is self-contained. Anything imported
    // from outside src/ would be a bug (the base entry must stay framework-free).
    splitting: false,
    minify: false,
})
