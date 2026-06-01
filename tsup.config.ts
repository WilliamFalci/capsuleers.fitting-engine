import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: false,
    treeshake: true,
    target: 'es2020',
    // No external runtime deps: the engine is self-contained. Anything imported
    // from outside src/ would be a bug (the package must stay framework-free).
    splitting: false,
    minify: false,
})
