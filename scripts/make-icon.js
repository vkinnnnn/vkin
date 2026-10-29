// Generates assets/icon.png (tray) and assets/icon.ico (desktop shortcut) without extra deps.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Blue disc with a white speech-bubble dot pattern, anti-aliased by 4x4 supersampling.
function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cover = (x, y) => {
    const cx = size / 2;
    const r = size * 0.47;
    const d = Math.hypot(x - cx, y - cx);
    if (d > r) return null;
    // three white dots = "speaking"
    const dotR = size * 0.075;
    for (const dx of [-0.2, 0, 0.2]) {
      if (Math.hypot(x - (cx + dx * size), y - cx) < dotR) return [255, 255, 255];
    }
    return [47, 128, 237];
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const c = cover(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO containing PNG images (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(32));
fs.writeFileSync(path.join(out, 'icon.ico'), ico([16, 32, 48, 256].map((size) => ({ size, png: render(size) }))));
console.log('wrote assets/icon.png and assets/icon.ico');
