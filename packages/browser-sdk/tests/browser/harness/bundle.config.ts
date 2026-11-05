import { defineConfig } from 'tsup';

// Bundle the public SDK and a separate internal identity test entry.
export default defineConfig({
  entry: { sdk: 'dist/index.js', identity: 'src/identity-store.ts' },
  format: ['esm'],
  platform: 'browser',
  outDir: '.browser-harness',
  noExternal: [/.*/],
  sourcemap: true,
  clean: true,
  // The fixture serves explicit assets; keep each entry self-contained.
  splitting: false,
});
