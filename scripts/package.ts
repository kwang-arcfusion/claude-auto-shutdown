// Builds a portable Windows app folder: release/Claude Auto Shutdown-win32-x64/
// Run with: npm run package   (then `npm run shortcut` for a Desktop shortcut)
import path from 'node:path';

void (async () => {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json') as { version: string; productName: string };
  // --out=<dir> packages somewhere else, e.g. to test a build while the app runs from release/.
  const outArg = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
  const outDir = outArg ? path.resolve(outArg) : path.join(root, 'release');
  const icon = path.join(root, 'assets', 'icon.ico'); // written by `npm run build` (scripts/icons.ts)

  const { packager } = await import('@electron/packager');
  const outputs = await packager({
    dir: root,
    name: pkg.productName,
    platform: 'win32',
    arch: 'x64',
    out: outDir,
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
      /^\/docs($|\/)/,
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
  // Electron fuses: switch off features this app never uses but malware could abuse through a
  // trusted-looking exe (run as plain Node, NODE_OPTIONS, --inspect), and only load the app from app.asar.
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  for (const output of outputs) {
    await flipFuses(path.join(output, `${pkg.productName}.exe`), {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
  }
  console.log(outputs.join('\n'));
})().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
