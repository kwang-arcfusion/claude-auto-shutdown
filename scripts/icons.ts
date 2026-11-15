// Writes the app icon from the geometry in src/main/icon.ts:
//   assets/icon.svg (favicon), assets/icon.ico (.exe and window), assets/icon.png (256 px)
// Runs as part of `npm run build`; the output is deterministic.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appIconSvg, renderAppIco, renderAppIcon } from '../src/main/icon';

const assets = path.resolve(__dirname, '..', 'assets');
mkdirSync(assets, { recursive: true });
writeFileSync(path.join(assets, 'icon.svg'), appIconSvg());
writeFileSync(path.join(assets, 'icon.ico'), renderAppIco());
writeFileSync(path.join(assets, 'icon.png'), renderAppIcon(256));
console.log('wrote assets/icon.svg, assets/icon.ico, assets/icon.png');
