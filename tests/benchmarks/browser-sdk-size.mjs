import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireSdk = createRequire(
  new URL('../../packages/browser-sdk/package.json', import.meta.url),
);
// Use the esbuild version owned by our pinned tsup toolchain; add no runtime dependency.
const { build, version } = createRequire(requireSdk.resolve('tsup/package.json'))('esbuild');
const report = {
  generatedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length >
    0,
  node: process.version,
  esbuild: version,
  assumptions: {
    target: 'es2022',
    format: 'esm',
    minify: true,
    treeShaking: true,
    gzipLevel: 9,
    brotliQuality: 11,
  },
  limitations: [
    'Standalone bundle measurements, not browser startup timings or a production framework build.',
    'No size budget is enforced until representative use and supported browsers are agreed.',
  ],
  entries: {},
};
for (const [name, contents] of Object.entries({
  publicApi: "export * from './packages/browser-sdk/dist/index.js';",
  automaticDelivery: "export {openAutomaticDelivery} from './packages/browser-sdk/dist/index.js';",
})) {
  const result = await build({
    stdin: { contents, resolveDir: root, sourcefile: name + '.js' },
    absWorkingDir: root,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const bytes = result.outputFiles[0].contents;
  const contributors = Object.values(result.metafile.outputs)
    .flatMap((output) =>
      Object.entries(output.inputs).map(([path, value]) => ({
        path,
        bytesInOutput: value.bytesInOutput,
      })),
    )
    .sort((a, b) => b.bytesInOutput - a.bytesInOutput)
    .slice(0, 10);
  report.entries[name] = {
    minifiedBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      .byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bundledInputs: Object.keys(result.metafile.inputs).length,
    largestContributors: contributors,
  };
}
const directory = resolve(root, 'test-results/sdk-size', report.generatedAt.replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({ directory, entries: report.entries, limitations: report.limitations }, null, 2),
);
