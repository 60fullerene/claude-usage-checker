// Draws the gauge icon used by both extensions and writes it as PNG files.
// Usage: node scripts/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { crc32 } from './zip.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const OUTPUTS = [
  ['desktop-extension/icon.png', 512],
  ['browser-extension/icons/icon16.png', 16],
  ['browser-extension/icons/icon32.png', 32],
  ['browser-extension/icons/icon48.png', 48],
  ['browser-extension/icons/icon128.png', 128],
];

const BACKGROUND = [31, 41, 55];
const TRACK = [75, 85, 99];
const GAUGE = [52, 211, 153];
const FILL = 0.7; // share of the ring drawn as used

/** Colour of point (x, y) in a unit square, or null for transparent. */
function sample(x, y) {
  const r = 0.2; // corner radius of the rounded square
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  const dx = x - 0.5;
  const dy = y - 0.5;
  const dist = Math.hypot(dx, dy);
  if (dist >= 0.26 && dist <= 0.36) {
    const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1; // 0 at 12 o'clock, clockwise
    return turn <= FILL ? GAUGE : TRACK;
  }
  return BACKGROUND;
}

function render(size) {
  const n = 4; // supersampling per axis
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const colour = sample((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size);
          if (!colour) continue;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) pixels.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((255 * a) / (n * n))], i);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [file, size] of OUTPUTS) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png(size, render(size)));
  console.log(`wrote ${file} (${size}x${size})`);
}
