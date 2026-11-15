import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appIconSvg, ICO_SIZES, renderAppIco, renderAppIcon, renderAppIconPixels } from '../src/main/icon';

function pixel(pixels: Uint8Array, size: number, x: number, y: number): [number, number, number, number] {
  const i = (y * size + x) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
}

test('256 px icon: transparent corners, dark tile, green glyph open at the top, light moon', () => {
  const px = renderAppIconPixels(256);
  assert.equal(pixel(px, 256, 2, 2)[3], 0, 'outside the rounded tile');

  const [tr, tg, tb, ta] = pixel(px, 256, 40, 200);
  assert.equal(ta, 255);
  assert.ok(tr < 40 && tg < 40 && tb < 40, `tile colour ${tr},${tg},${tb}`);

  const [gr, gg, gb] = pixel(px, 256, 128, 90);
  assert.ok(gg > 150 && gg > gr + 60 && gg > gb, `bar colour ${gr},${gg},${gb}`);

  const [, gapG] = pixel(px, 256, 150, 72);
  assert.ok(gapG < 60, 'the ring stays open at the top');

  const [mr, mg, mb] = pixel(px, 256, 188, 64);
  assert.ok(mr > 200 && mg > 200 && mb > 200, `moon colour ${mr},${mg},${mb}`);
});

test('tray variants use a solid state colour and leave out the moon', () => {
  const px = renderAppIconPixels(256, { glyph: [255, 107, 107], moon: false });
  assert.deepEqual(pixel(px, 256, 128, 90).slice(0, 3), [255, 107, 107]);
  const [mr, mg, mb] = pixel(px, 256, 188, 64);
  assert.ok(mr < 40 && mg < 40 && mb < 40, 'no moon');
});

test('the glyph is still visible at 16 px', () => {
  const [r, g, b, a] = pixel(renderAppIconPixels(16, { glyph: [61, 220, 151], moon: false }), 16, 8, 5);
  assert.ok(a === 255 && g > 120, `bar pixel ${r},${g},${b},${a}`);
});

test('PNG and ICO outputs', () => {
  const png = renderAppIcon(48);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 48);
  const ico = renderAppIco();
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  assert.equal(ico.readUInt8(6 + 16 * (ICO_SIZES.length - 1)), 0); // 256 px is stored as 0
});

test('assets/icon.svg is up to date with the generator', () => {
  const committed = readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, appIconSvg(), 'assets/icon.svg is stale: run npm run icons');
  assert.match(committed, /viewBox="0 0 256 256"/);
  assert.match(appIconSvg({ moon: false, glyph: [255, 107, 107] }), /stroke="#ff6b6b"/);
  assert.doesNotMatch(appIconSvg({ moon: false }), /mask/);
});
