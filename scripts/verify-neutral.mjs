// Quantitative evaluation check: drives the real Web Core at the neutral
// pose and at angle sweeps, comparing per-drawable vertex positions against
// the file's keyform slots read directly. No vision involved.
// Usage: node scripts/verify-neutral.mjs <core.js> <model.moc3>
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readMoc3 } from './moc3-reader.mjs';

const corePath = process.argv[2];
const modelPath = process.argv[3];

const m = readMoc3(modelPath);
const bytes = m.bytes;

const sandbox = {
    console, setTimeout, clearTimeout,
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    btoa: (t) => Buffer.from(t, 'binary').toString('base64'),
    TextDecoder, TextEncoder,
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.document = { currentScript: null };
sandbox.location = { href: 'file:///' };
vm.createContext(sandbox);
vm.runInContext(readFileSync(corePath, 'utf8'), sandbox);
await new Promise((resolve) => setTimeout(resolve, 1500));
const core = sandbox.Live2DCubismCore;

const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const moc = core.Moc.fromArrayBuffer(ab);
if (!moc) throw new Error('parse failed');
console.log('consistency:', moc.hasMocConsistency(ab));
const model = core.Model.fromMoc(moc);

const paramIds = Array.from(model.parameters.ids);
const readSlotPositions = (amIndex, slotIndex) => {
    const n = m.am.vertexCounts[amIndex];
    const base = m.view.getInt32(m.slot('amKf.kpBegins') + (m.am.ksbi[amIndex] + slotIndex) * 4, true);
    const out = new Float32Array(n * 2);
    for (let v = 0; v < n; v += 1) {
        out[v * 2] = m.view.getFloat32(m.slot('kfPos.xys') + (base + v * 2) * 4, true);
        out[v * 2 + 1] = m.view.getFloat32(m.slot('kfPos.xys') + (base + v * 2 + 1) * 4, true);
    }
    return out;
};

const run = (label, assignment) => {
    const values = model.parameters.values;
    paramIds.forEach((id, i) => {
        if (id in assignment) values[i] = assignment[id];
    });
    model.update();
    const corePos = model.drawables.vertexPositions;
    console.log(`\n== ${label} ==`);
    m.am.ids.forEach((id, amIndex) => {
        const n = m.am.vertexCounts[amIndex];
        const cp = Array.from(corePos[amIndex]);
        // Slot under this assignment: per-axis nearest-or-exact key index for
        // the driven params (neutral index otherwise) in binding pool order,
        // enumerated LAST-OUTER (axis 0 fastest) — the rule the real Core
        // applies (verified against its parameter response table).
        let slotIndex = 0;
        let stride = 1;
        m.bindings[amIndex].forEach((binding) => {
            const value = assignment[binding.paramId] ?? m.params.def[binding.paramIndex];
            let idx = 0;
            let best = Infinity;
            binding.values.forEach((k, i) => {
                if (Math.abs(k - value) < best) {
                    best = Math.abs(k - value);
                    idx = i;
                }
            });
            slotIndex += idx * stride;
            stride *= binding.values.length;
        });
        const fp = readSlotPositions(amIndex, slotIndex);
        let maxErr = 0;
        for (let v = 0; v < n * 2; v += 1) {
            // Core exposes positions with Y flipped vs the file.
            const expected = v % 2 === 0 ? fp[v] : -fp[v];
            maxErr = Math.max(maxErr, Math.abs(cp[v] - expected));
        }
        const flag = maxErr > 1e-4 ? '  ** MISMATCH **' : '';
        if (maxErr > 1e-4) {
            console.log(String(amIndex).padStart(2), id.padEnd(10), `slot=${slotIndex} maxErr=${maxErr.toFixed(6)}${flag}`);
        }
    });
    console.log('(only mismatches printed)');
};

run('neutral', {});
run('AngleX=+30', { ParamAngleX: 30 });
run('AngleX=-30 AngleY=+30', { ParamAngleX: -30, ParamAngleY: 30 });
run('AngleZ=-30 EyeL=0.5 MouthOpenY=1', { ParamAngleZ: -30, ParamEyeLOpen: 0.5, ParamMouthOpenY: 1 });
