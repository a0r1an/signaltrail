import { defineConfig } from 'tsup';

// Bundle the package's built public entry, including its runtime dependencies.
export default defineConfig({
  entry: { sdk: 'dist/index.js' },
  format: ['esm'],
  platform: 'browser',
  outDir: '.browser-harness',
  noExternal: [/.*/],
  sourcemap: true,
  clean: true,
});
