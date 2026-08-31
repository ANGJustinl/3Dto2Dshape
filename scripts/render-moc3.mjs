// Dev tool: software-renders a .moc3 with the REAL Cubism Core so the
// exported geometry can be inspected without VTube Studio. Draws flat
// colors per drawable (shape check); optionally samples a texture PNG.
// Usage: node scripts/render-moc3.mjs <core.js> <model.moc3> <out.png> [--texture t.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const corePath = process.argv[2];
const modelPath = process.argv[3];
const outPath = process.argv[4];
const textureFlag = process.argv.indexOf('--texture');
const texturePath = textureFlag >= 0 ? process.argv[textureFlag + 1] : null;
const texture = texturePath ? require('./png-decode.cjs')(texturePath) : null;
if (texture) {
    console.log(`texture: ${texture.width}x${texture.height}`);
}

const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    btoa: (t) => Buffer.from(t, 'binary').toString('base64'),
    TextDecoder,
    TextEncoder,
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.document = { currentScript: null };
sandbox.location = { href: 'file:///' };
vm.createContext(sandbox);
vm.runInContext(readFileSync(corePath, 'utf8'), sandbox);
await new Promise((resolve) => setTimeout(resolve, 1500));
const core = sandbox.Live2DCubismCore;

const bytes = readFileSync(modelPath);
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const moc = core.Moc.fromArrayBuffer(arrayBuffer);
if (!moc) {
    throw new Error('moc parse failed');
}
const model = core.Model.fromMoc(moc);
if (!model) {
    throw new Error('model init failed');
}
const info = model.canvasinfo;
const ppu = info.PixelsPerUnit;
const W = Math.round(info.CanvasWidth);
const H = Math.round(info.CanvasHeight);
console.log(`canvas: ${W}x${H} ppu=${ppu} origin=(${info.CanvasOriginX},${info.CanvasOriginY})`);

// Neutral pose: defaults (values is a WASM-backed view: mutate in place).
const paramIds = Array.from(model.parameters.ids);
const defaultValues = Array.from(model.parameters.defaultValues);
const drive = (assignment) => {
    const values = model.parameters.values;
    paramIds.forEach((id, index) => {
        values[index] = id in assignment ? assignment[id] : defaultValues[index];
    });
    model.update();
};
// Pose overrides: --ParamAngleX=-30 --ParamMouthOpenY=0.8 ...
const overrides = {};
process.argv.slice(5).forEach((arg) => {
    const match = arg.match(/^--([A-Za-z]+)=(.+)$/);
    if (match) overrides[match[1]] = Number(match[2]);
});
drive(overrides);
const rgba = new Float32Array(W * H * 4);

const drawables = model.drawables;
const counts = Array.from(drawables.vertexCounts);
const orders = Array.from(drawables.renderOrders);
const ids = Array.from(drawables.ids);
const opacity = Array.from(drawables.opacities);
const palette = [
    [0.85, 0.33, 0.1], [0.1, 0.6, 0.85], [0.55, 0.75, 0.2], [0.8, 0.8, 0.25],
    [0.6, 0.3, 0.7], [0.25, 0.65, 0.6], [0.9, 0.5, 0.6], [0.4, 0.4, 0.45],
    [0.7, 0.55, 0.3], [0.35, 0.5, 0.8], [0.65, 0.75, 0.7], [0.9, 0.4, 0.3],
    [0.5, 0.8, 0.4], [0.75, 0.35, 0.55], [0.3, 0.7, 0.75], [0.85, 0.7, 0.45],
];
const byRender = ids.map((_, i) => i).sort((a, b) => orders[a] - orders[b]);
let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
byRender.forEach((drawableIndex) => {
    const n = counts[drawableIndex];
    const positions = Array.from(drawables.vertexPositions[drawableIndex]);
    for (let v = 0; v < n; v++) {
        const x = positions[v * 2] * ppu + W / 2;
        const y = -positions[v * 2 + 1] * ppu + H / 2;
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
});
console.log(`projected vertex bounds: x [${xMin.toFixed(0)}, ${xMax.toFixed(0)}] y [${yMin.toFixed(0)}, ${yMax.toFixed(0)}] (canvas ${W}x${H})`);

byRender.forEach((drawableIndex, rank) => {
    const n = counts[drawableIndex];
    const positions = Array.from(drawables.vertexPositions[drawableIndex]);
    const indexList = Array.from(drawables.indices[drawableIndex]);
    const uvs = texture ? Array.from(drawables.vertexUvs[drawableIndex]) : null;
    const color = palette[rank % palette.length];
    const alpha = opacity[drawableIndex];
    void alpha;
    const project = (v) => ({
        x: positions[v * 2] * ppu + W / 2,
        y: -positions[v * 2 + 1] * ppu + H / 2,
    });
    for (let t = 0; t + 2 < indexList.length; t += 3) {
        const a = project(indexList[t]);
        const b = project(indexList[t + 1]);
        const c = project(indexList[t + 2]);
        const uvA = uvs ? [uvs[indexList[t] * 2], uvs[indexList[t] * 2 + 1]] : null;
        const uvB = uvs ? [uvs[indexList[t + 1] * 2], uvs[indexList[t + 1] * 2 + 1]] : null;
        const uvC = uvs ? [uvs[indexList[t + 2] * 2], uvs[indexList[t + 2] * 2 + 1]] : null;
        const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (Math.abs(area) < 1e-9) continue;
        for (let py = minY; py <= maxY; py++) {
            for (let px = minX; px <= maxX; px++) {
                const w0 = ((b.x - a.x) * (py + 0.5 - a.y) - (px + 0.5 - a.x) * (b.y - a.y)) / area;
                const w1 = ((px + 0.5 - a.x) * (c.y - a.y) - (c.x - a.x) * (py + 0.5 - a.y)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const offset = (py * W + px) * 4;
                if (uvs) {
                    const u = uvA[0] * w0 + uvB[0] * w1 + uvC[0] * w2;
                    const v = uvA[1] * w0 + uvB[1] * w1 + uvC[1] * w2;
                    // Core's vertexUvs are already top-down: sample directly.
                    const tx = Math.min(texture.width - 1, Math.max(0, Math.round(u * texture.width)));
                    const ty = Math.min(texture.height - 1, Math.max(0, Math.round((1 - v) * texture.height)));
                    const src = (ty * texture.width + tx) * 4;
                    if (texture.rgba[src + 3] === 0) continue; // transparent texel: skip
                    rgba[offset] = texture.rgba[src] / 255;
                    rgba[offset + 1] = texture.rgba[src + 1] / 255;
                    rgba[offset + 2] = texture.rgba[src + 2] / 255;
                    rgba[offset + 3] = 1;
                } else {
                    rgba[offset] = color[0];
                    rgba[offset + 1] = color[1];
                    rgba[offset + 2] = color[2];
                    rgba[offset + 3] = 1;
                }
            }
        }
    }
});

// Encode PNG (RGBA, filter 0).
const rowBytes = W * 4;
const raw = Buffer.alloc((rowBytes + 1) * H);
for (let y = 0; y < H; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < rowBytes; x++) {
        raw[y * (rowBytes + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(rgba[y * rowBytes + x] * 255)));
    }
}
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(outPath, png);
console.log(`rendered ${byRender.length} drawables (flat colors) -> ${outPath}`);
void texturePath;
