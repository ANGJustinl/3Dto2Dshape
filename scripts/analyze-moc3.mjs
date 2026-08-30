// Dev tool: dumps the structural layout of a .moc3 file (header, section
// pointer table, count table, canvas) so exports can be diffed against
// known-good Cubism files. Usage: node scripts/analyze-moc3.mjs <file.moc3>
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (offset) => view.getUint32(offset, true);
const f32 = (offset) => view.getFloat32(offset, true);
const s32 = (offset) => view.getInt32(offset, true);
const ascii = (offset, length = 64) => {
    const raw = bytes.subarray(offset, offset + length);
    let end = raw.indexOf(0);
    if (end < 0) {
        end = raw.length;
    }
    return new TextDecoder().decode(raw.subarray(0, end));
};

console.log(`file: ${process.argv[2]}`);
console.log(`size: ${bytes.length}`);
console.log(`magic: ${ascii(0, 4)} version: ${bytes[4]} endian: ${bytes[5]}`);

// Find the first nonzero byte after the 64-byte header to locate the pointer
// table and the first data section.
let firstNonZero = -1;
for (let offset = 64; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== 0) {
        firstNonZero = offset;
        break;
    }
}
console.log(`first nonzero after header: 0x${firstNonZero.toString(16)}`);

const dumpU32 = (from, to) => {
    for (let offset = from; offset < to; offset += 4) {
        console.log(`  0x${offset.toString(16).padStart(4, '0')} (u32): ${u32(offset)}`);
    }
};

console.log('\n-- candidate section pointer table (0x40..0x340) --');
dumpU32(0x40, 0x340);

const pointers = [];
for (let offset = 0x40; offset < 0x340; offset += 4) {
    const value = u32(offset);
    if (value >= 0x340 && value < bytes.length) {
        pointers.push({ slot: offset, value });
    }
}
console.log(`\nplausible pointers: ${pointers.length}`);
console.log(
    pointers
        .map((entry) => `slot 0x${entry.slot.toString(16)} -> 0x${entry.value.toString(16)}`)
        .join('\n'),
);

if (pointers.length > 0) {
    const firstTarget = pointers[0].value;
    console.log(`\n-- count table region @0x${firstTarget.toString(16)} (64 u32) --`);
    dumpU32(firstTarget, firstTarget + 256);
    console.log(`\n-- canvas probe @0x${(firstTarget + 0x100).toString(16)} as floats --`);
    for (let index = 0; index < 8; index += 1) {
        console.log(`  f32[${index}]: ${f32(firstTarget + 0x100 + index * 4)}`);
    }
}

console.log('\n-- ascii probes across early file (id arrays) --');
for (let offset = 0x40; offset < Math.min(bytes.length, 0x4000); offset += 4) {
    const chunk = bytes[offset];
    if (chunk >= 0x20 && chunk < 0x7f && bytes[offset + 1] >= 0x20 && bytes[offset + 1] < 0x7f) {
        const text = ascii(offset, 24);
        if (/^[A-Za-z][A-Za-z0-9 _]{5,}/.test(text)) {
            console.log(`  0x${offset.toString(16)}: "${text}"`);
        }
    }
}
