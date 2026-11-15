// Bundles main, preload and renderer with esbuild into dist/.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, legalComments: 'none', logLevel: 'warning' };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'node:sqlite'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/renderer.ts'],
    outfile: 'dist/renderer/renderer.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  }),
]);

await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
// Icons are generated into assets/ by scripts/icons.ts (run first by `npm run build`).
await cp('assets/icon.svg', 'dist/renderer/icon.svg');
await cp('assets/icon.ico', 'dist/icon.ico');
console.log('built dist/');
