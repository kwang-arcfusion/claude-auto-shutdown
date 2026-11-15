// Builds a portable Windows app folder: release/Claude Auto Shutdown-win32-x64/
// Run with: npm run package   (then `npm run shortcut` for a Desktop shortcut)
import path from 'node:path';

void (async () => {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json') as { version: string; productName: string };
  const icon = path.join(root, 'assets', 'icon.ico'); // written by `npm run build` (scripts/icons.ts)

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
      // Everything the app needs is bundled into dist/ (icons included), so nothing else ships.
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/assets($|\/)/,
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
