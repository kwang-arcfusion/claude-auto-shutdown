// Builds a portable Windows app folder: release/Claude Auto Shutdown-win32-x64/
// Run with: npm run package
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeIco, renderPowerIcon } from '../src/main/icon';

void (async () => {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json') as { version: string; productName: string };

  const buildDir = path.join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const icon = path.join(buildDir, 'icon.ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  writeFileSync(icon, encodeIco(sizes.map((size) => ({ size, png: renderPowerIcon(size, [34, 160, 107]) }))));

  const { packager } = await import('@electron/packager');
  const outputs = await packager({
    dir: root,
    name: pkg.productName,
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'release'),
    overwrite: true,
    asar: true,
    prune: true,
    icon,
    appVersion: pkg.version,
    ignore: [
      // Everything the app needs is bundled into dist/, so no node_modules at all.
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/build($|\/)/,
      /^\/release($|\/)/,
      /^\/tsconfig\.json$/,
      /^\/package-lock\.json$/,
      /^\/README\.md$/,
      /^\/\.gitignore$/,
      /\.map$/,
    ],
    win32metadata: {
      ProductName: pkg.productName,
      FileDescription: pkg.productName,
      InternalName: 'claude-auto-shutdown',
      OriginalFilename: `${pkg.productName}.exe`,
    },
  });
  console.log(outputs.join('\n'));
})().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
