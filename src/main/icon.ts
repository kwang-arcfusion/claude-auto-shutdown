import { deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes 8-bit RGBA pixels as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A coloured disc with a white power symbol, anti-aliased by 4×4 supersampling. */
export function renderPowerIcon(size: number, color: Rgb): Buffer {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const discRadius = size * 0.48;
  const ringRadius = size * 0.25;
  const stroke = Math.max(1.2, size * 0.09);
  const gap = (40 * Math.PI) / 180; // half-width of the opening at the top of the ring
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let disc = 0;
      let symbol = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) / samples - center;
          const dy = y + (sy + 0.5) / samples - center;
          const distance = Math.hypot(dx, dy);
          if (distance > discRadius) continue;
          disc++;
          const angleFromTop = Math.atan2(dx, -dy);
          const onRing = Math.abs(distance - ringRadius) <= stroke / 2 && Math.abs(angleFromTop) >= gap;
          const onBar = Math.abs(dx) <= stroke / 2 && dy <= -ringRadius * 0.12 && dy >= -(ringRadius + stroke * 0.6);
          if (onRing || onBar) symbol++;
        }
      }
      if (disc === 0) continue;
      const white = symbol / disc;
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(color[0] * (1 - white) + 255 * white);
      pixels[i + 1] = Math.round(color[1] * (1 - white) + 255 * white);
      pixels[i + 2] = Math.round(color[2] * (1 - white) + 255 * white);
      pixels[i + 3] = Math.round((disc / (samples * samples)) * 255);
    }
  }
  return encodePng(size, size, pixels);
}

/** Packs PNG images into a .ico file (PNG entries are valid since Windows Vista). */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}
