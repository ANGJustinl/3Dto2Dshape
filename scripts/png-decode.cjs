// minimal PNG decoder (truecolor RGBA, 8-bit, standard filters)
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
module.exports = (path) => {
  const png = readFileSync(path);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  let pos = 8;
  let idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    prev = cur;
  }
  return { width, height, rgba: out };
};
module.paths.push(process.argv[2] ?? '');
