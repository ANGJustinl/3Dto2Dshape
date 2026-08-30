// Dev tool: fixes first-generation moc3 exports that stored keyform
// positions in pixels (they must be model units = pixels / ppu) and a
// top-left canvas origin (must be the canvas center).
// Usage: node scripts/fix-moc3-units.mjs <in.moc3> <out.moc3>
import { readFileSync, writeFileSync } from 'node:fs';

const bytes = Buffer.from(readFileSync(process.argv[2]));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const canvas = view.getUint32(0x40 + 1 * 4, true);
const width = view.getFloat32(canvas + 12, true);
const height = view.getFloat32(canvas + 16, true);
const ppu = view.getFloat32(canvas, true);
console.log(`canvas ${width}x${height} ppu=${ppu}`);
// Origin -> canvas center.
view.setFloat32(canvas + 4, width / 2, true);
view.setFloat32(canvas + 8, height / 2, true);
// kfPos (slot 71): floats count from count table, divide by ppu.
const kfPos = view.getUint32(0x40 + 71 * 4, true);
const floatCount = view.getUint32(0x7c0 + 10 * 4, true);
for (let index = 0; index < floatCount; index += 1) {
    view.setFloat32(kfPos + index * 4, view.getFloat32(kfPos + index * 4, true) / ppu, true);
}
writeFileSync(process.argv[3], bytes);
console.log(`scaled ${floatCount} position floats by 1/${ppu} -> ${process.argv[3]}`);
