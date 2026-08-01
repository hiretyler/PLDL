// Generates a 1024x1024 square PNG app-icon source with no external deps.
// Dark background (#0c0c0e) + amber (#f59e0b) "download" glyph (down arrow into a tray).
// Output: build/icon-source.png  ->  feed to `cargo tauri icon`.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA

const BG = [0x0c, 0x0c, 0x0e];
const AMBER = [0xf5, 0x9e, 0x0b];

function px(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple alpha blend over existing
  const ia = a / 255;
  buf[i]     = Math.round(buf[i]     * (1 - ia) + r * ia);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - ia) + g * ia);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - ia) + b * ia);
  buf[i + 3] = Math.max(buf[i + 3], a);
}

// fill background opaque
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, BG, 255);

// helpers
const fillRect = (x0, y0, w, h, c) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c);
};

// --- Download glyph: vertical shaft + arrowhead + tray ---
const cx = S / 2;

// shaft
const shaftW = 150;
fillRect(cx - shaftW / 2, 230, shaftW, 320, AMBER);

// arrowhead (downward triangle)
const headTop = 470;
const headBot = 700;
const headHalf = 230;
for (let y = headTop; y <= headBot; y++) {
  const t = (y - headTop) / (headBot - headTop); // 0..1
  const half = headHalf * (1 - t);
  for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) px(x, y, AMBER);
}

// tray (open box at bottom): left wall, right wall, base
const trayTop = 720;
const trayW = 560;
const trayThick = 90;
const trayX = cx - trayW / 2;
const trayH = 130;
// base
fillRect(trayX, trayTop + trayH - trayThick, trayW, trayThick, AMBER);
// left wall
fillRect(trayX, trayTop, trayThick, trayH, AMBER);
// right wall
fillRect(trayX + trayW - trayThick, trayTop, trayThick, trayH, AMBER);

// --- encode PNG ---
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw, { level: 9 });

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon-source.png', png);
console.log('wrote build/icon-source.png', png.length, 'bytes');
