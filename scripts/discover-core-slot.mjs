// Dev tool: drives a REAL Editor-made moc3 (tororo/hiyori, proven in VTS)
// through the Web Core and discovers, per drawable, which keyform slot the
// Core actually read for an asymmetric pose. Compares the discovered slot
// against first-outer vs last-outer enumeration predictions to pin the
// Editor's true tensor order.
// Usage: node scripts/discover-core-slot.mjs <file.moc3>
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const corePath = 'C:/Users/77139/AppData/Local/Temp/live2dcubismcore.min.js';
const modelPath = process.argv[2];

const bytes = readFileSync(modelPath);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (o) => view.getUint32(o, true);
const s32 = (o) => view.getInt32(o, true);
const f32 = (o) => view.getFloat32(o, true);

const SLOTS = [
    'countInfo', 'canvas',
    'parts.runtime0', 'parts.ids', 'parts.kbsi', 'parts.ksbi', 'parts.ksc', 'parts.visible', 'parts.enabled', 'parts.parentPart',
    'deformers.runtime0', 'deformers.ids', 'deformers.kbsi', 'deformers.visible', 'deformers.enabled', 'deformers.parentPart', 'deformers.parentDeformer', 'deformers.types', 'deformers.specificSources',
    'warp.kbsi', 'warp.ksbi', 'warp.ksc', 'warp.vertexCounts', 'warp.rows', 'warp.columns',
    'rotation.kbsi', 'rotation.ksbi', 'rotation.ksc', 'rotation.baseAngles',
    'am.runtime0', 'am.runtime1', 'am.runtime2', 'am.runtime3', 'am.ids', 'am.kbsi', 'am.ksbi', 'am.ksc', 'am.visible', 'am.enabled', 'am.parentPart', 'am.parentDeformer', 'am.textureNos', 'am.flags', 'am.vertexCounts', 'am.uvBegins', 'am.piBegins', 'am.piCounts', 'am.maskBegins', 'am.maskCounts',
    'params.runtime0', 'params.ids', 'params.max', 'params.min', 'params.default', 'params.repeat', 'params.decimals', 'params.pbsbi', 'params.pbsc',
    'partKf.drawOrders',
    'warpKf.opacities', 'warpKf.kpBegins',
    'rotKf.opacities', 'rotKf.angles', 'rotKf.originX', 'rotKf.originY', 'rotKf.scales', 'rotKf.reflectX', 'rotKf.reflectY',
    'amKf.opacities', 'amKf.drawOrders', 'amKf.kpBegins',
    'kfPos.xys',
    'pbi.bindingSourcesIndices',
    'kb.pbisbi', 'kb.pbisc',
    'pb.keysBegins', 'pb.keysCounts',
    'keys.values',
    'uv.uvs',
    'pi.indices',
    'masks.artMeshSourcesIndices',
    'groups.objBegins', 'groups.objCounts', 'groups.objTotalCounts', 'groups.maxDrawOrders', 'groups.minDrawOrders',
    'groupObjects.types', 'groupObjects.indices', 'groupObjects.selfIndices',
    'glue.runtime0', 'glue.ids', 'glue.kbsi', 'glue.ksbi', 'glue.ksc', 'glue.amA', 'glue.amB', 'glue.infoBegins', 'glue.infoCounts',
    'glueInfo.weights', 'glueInfo.positionIndices',
    'glueKf.intensities',
];
const slot = (name) => u32(0x40 + SLOTS.indexOf(name) * 4);
const target = (name) => slot(name);
const id = (o) => {
    const raw = bytes.subarray(o, o + 64);
    let end = raw.indexOf(0);
    if (end < 0) end = 64;
    return new TextDecoder().decode(raw.subarray(0, end));
};
const c = {};
['parts', 'deformers', 'warp', 'rotation', 'artMeshes', 'parameters', 'partKeyforms',
    'warpDeformerKeyforms', 'rotationDeformerKeyforms', 'artMeshKeyforms', 'keyformPositions',
    'parameterBindingIndices', 'keyformBindings', 'parameterBindings', 'keys', 'uvs',
    'positionIndices', 'drawableMasks', 'drawOrderGroups', 'drawOrderGroupObjects',
    'glue', 'glueInfo', 'glueKeyforms',
].forEach((name, index) => { c[name] = u32(target('countInfo') + index * 4); });

const paramIds = Array.from({ length: c.parameters }, (_, i) => id(target('params.ids') + i * 64));
const pbsbi = Array.from({ length: c.parameters }, (_, i) => s32(target('params.pbsbi') + i * 4));
const pbsc = Array.from({ length: c.parameters }, (_, i) => s32(target('params.pbsc') + i * 4));
const pmin = Array.from({ length: c.parameters }, (_, i) => f32(target('params.min') + i * 4));
const pmax = Array.from({ length: c.parameters }, (_, i) => f32(target('params.max') + i * 4));
const pdef = Array.from({ length: c.parameters }, (_, i) => f32(target('params.default') + i * 4));
const pbi = Array.from({ length: c.parameterBindingIndices }, (_, i) => s32(target('pbi.bindingSourcesIndices') + i * 4));
const kbBegins = Array.from({ length: c.keyformBindings }, (_, i) => s32(target('kb.pbisbi') + i * 4));
const kbCounts = Array.from({ length: c.keyformBindings }, (_, i) => s32(target('kb.pbisc') + i * 4));
const pbKeysBegins = Array.from({ length: c.parameterBindings }, (_, i) => s32(target('pb.keysBegins') + i * 4));
const pbKeysCounts = Array.from({ length: c.parameterBindings }, (_, i) => s32(target('pb.keysCounts') + i * 4));
const keyValues = (pi) => Array.from({ length: pbKeysCounts[pi] }, (_, i) => f32(target('keys.values') + (pbKeysBegins[pi] + i) * 4));
const amVc = Array.from({ length: c.artMeshes }, (_, i) => s32(target('am.vertexCounts') + i * 4));
const amKsbi = Array.from({ length: c.artMeshes }, (_, i) => s32(target('am.ksbi') + i * 4));
const amKsc = Array.from({ length: c.artMeshes }, (_, i) => s32(target('am.ksc') + i * 4));
const amKp = Array.from({ length: c.artMeshKeyforms }, (_, i) => s32(target('amKf.kpBegins') + i * 4));
const kfBase = target('kfPos.xys');
const readSlot = (kf, vc) => {
    const out = new Float32Array(vc * 2);
    for (let v = 0; v < vc; v++) {
        out[v * 2] = f32(kfBase + (amKp[kf] + v * 2) * 4);
        out[v * 2 + 1] = f32(kfBase + (amKp[kf] + v * 2 + 1) * 4);
    }
    return out;
};

// --- Web Core (vm sandbox, same as verify-neutral) ---
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
const values = model.parameters.values;
const coreParamIds = Array.from(model.parameters.ids).map(String);
console.log('core params:', coreParamIds.length, 'file params:', c.parameters);

const digitOf = (pi, value) => {
    const keys = keyValues(pi);
    let best = 0;
    let bestD = Infinity;
    keys.forEach((k, i) => {
        const d = Math.abs(k - value);
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
};

// Which kb does the core use for a param: its pbs slice points to pbi entries;
// each pbi entry is a parameter binding index. A mesh's first kb index
// (amKbsi) identifies the binding actually applied. (tororo: 1 kb/mesh here.)
const amKbsi = Array.from({ length: c.artMeshes }, (_, i) => s32(target('am.kbsi') + i * 4));

const predict = (mesh, valueByParam) => {
    const kbi = amKbsi[mesh];
    const axes = pbi.slice(kbBegins[kbi], kbBegins[kbi] + kbCounts[kbi]);
    if (axes.length === 0) return { axes };
    const digits = axes.map((pi) => digitOf(pi, valueByParam[pi]));
    const radices = axes.map((pi) => keyValues(pi).length);
    let fo = 0;
    let stride = 1;
    for (let a = 0; a < axes.length; a++) { fo += digits[a] * stride; stride *= radices[a]; }
    let lo = 0;
    let stride2 = 1;
    for (let a = axes.length - 1; a >= 0; a--) { lo += digits[a] * stride2; stride2 *= radices[a]; }
    return { axes, digits, radices, fo, lo };
};

const discoverPose = (label, overrides) => {
    console.log(`\n=== pose ${label} ===`);
    // reset to defaults, then apply overrides
    paramIds.forEach((pid, i) => {
        const ci = coreParamIds.indexOf(pid);
        if (ci >= 0) values[ci] = pdef[i];
    });
    for (const [pid, val] of Object.entries(overrides)) {
        const ci = coreParamIds.indexOf(pid);
        if (ci >= 0) values[ci] = val;
        else console.log(`  (param ${pid} not in core)`);
    }
    model.update();

    let foHits = 0;
    let loHits = 0;
    let noMatch = 0;
    let tieOrder = 0;
    const detail = [];
    for (let m = 0; m < c.artMeshes; m++) {
        const vc = amVc[m];
        const valueByParam = paramIds.map((pid, i) => {
            const ci = coreParamIds.indexOf(pid);
            return ci >= 0 ? values[ci] : pdef[i];
        });
        const pred = predict(m, valueByParam);
        if (!pred.fo) continue;
        if (pred.axes.length === 0 || pred.fo === pred.lo) { tieOrder++; continue; }
        const foSlot = pred.fo;
        const loSlot = pred.lo;
        const out = Array.from(model.drawables.vertexPositions[m]);
        const dist = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) { const d = arr[i] - out[i]; s += d * d; } return s; };
        const dFo = dist(readSlot(amKsbi[m] + foSlot, vc));
        const dLo = dist(readSlot(amKsbi[m] + loSlot, vc));
        let bestK = -1;
        let bestD = Infinity;
        for (let k2 = 0; k2 < amKsc[m]; k2++) {
            const d = dist(readSlot(amKsbi[m] + k2, vc));
            if (d < bestD) { bestD = d; bestK = k2; }
        }
        const bestIsFo = bestK === foSlot;
        const bestIsLo = bestK === loSlot;
        if (bestIsFo && !bestIsLo) foHits++;
        else if (bestIsLo && !bestIsFo) loHits++;
        else noMatch++;
        detail.push(`  mesh ${m} vc=${vc} axes=[${pred.axes.map((p) => paramIds[p])}] digits=${pred.digits} fo=${foSlot} lo=${loSlot} argmin=${bestK} dFo=${dFo.toExponential(2)} dLo=${dLo.toExponential(2)}`);
    }
    console.log(`compared: foHits=${foHits} loHits=${loHits} noMatch=${noMatch} orderIndependent=${tieOrder}`);
    detail.slice(0, 12).forEach((l) => console.log(l));
    return { foHits, loHits, noMatch };
};

const poses = [
    ['X+30', { ParamAngleX: 30 }],
    ['X-30 Y+30', { ParamAngleX: -30, ParamAngleY: 30 }],
    ['X+30 Y+30 Z-30', { ParamAngleX: 30, ParamAngleY: 30, ParamAngleZ: -30 }],
    ['X-30 Y-30 Z+30', { ParamAngleX: -30, ParamAngleY: -30, ParamAngleZ: 30 }],
];

let totFo = 0;
let totLo = 0;
let totNo = 0;
for (const [label, ov] of poses) {
    const r = discoverPose(label, ov);
    totFo += r.foHits;
    totLo += r.loHits;
    totNo += r.noMatch;
}
console.log(`\nTOTAL: first-outer=${totFo}  last-outer=${totLo}  neither=${totNo}`);
console.log(totFo > totLo * 2 ? '=> CORE READS FIRST-OUTER (axis0 fastest)' : totLo > totFo * 2 ? '=> CORE READS LAST-OUTER (axis0 slowest)' : '=> INCONCLUSIVE');
