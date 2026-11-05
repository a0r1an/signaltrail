import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { explorer: 'tests/browser/entry.tsx' },
  format: ['esm'],
  platform: 'browser',
  outDir: '.browser-harness',
  noExternal: [/.*/],
  sourcemap: true,
  clean: true,
  loader: { '.css': 'local-css' },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
