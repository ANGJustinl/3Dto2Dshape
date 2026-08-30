// Dev tool: dumps keyform layout invariants of a moc3 so the REAL
// Editor-produced files (VTS sample models) can be compared against ours.
// Usage: node scripts/dump-keyform-layout.mjs <file.moc3> [detail]
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (o) => view.getUint32(o, true);
const s32 = (o) => view.getInt32(o, true);
const f32 = (o) => view.getFloat32(o, true);

if (bytes.subarray(0, 4).toString('latin1') !== 'MOC3') throw new Error('not a moc3');
console.log(`file: ${process.argv[2]}  version: ${bytes[4]}  size: ${bytes.length}`);

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
console.log('counts:', JSON.stringify(c));

const ia = (name, count, rd = s32, off = 0) => Array.from({ length: count }, (_, i) => rd(target(name) + off + i * 4));

const amVc = ia('am.vertexCounts', c.artMeshes);
const amKsbi = ia('am.ksbi', c.artMeshes);
const amKsc = ia('am.ksc', c.artMeshes);
const amKbsi = ia('am.kbsi', c.artMeshes);
const amKp = ia('amKf.kpBegins', c.artMeshKeyforms);
const kfPosCount = c.keyformPositions;

console.log('\n== kfPos pool ==');
console.log(`keyformPositions (f32 count): ${kfPosCount}`);
const sumRaw = amVc.reduce((acc, vc, i) => acc + amKsc[i] * vc * 2, 0);
console.log(`sum over artmeshes (ksc * vc * 2): ${sumRaw}  (padded16: ${ia('am.vertexCounts', c.artMeshes).reduce((acc, vc, i) => acc + amKsc[i] * Math.ceil((vc * 2) / 16) * 16, 0)})`);
const maxKp = amKp.reduce((m, v) => Math.max(m, v), -Infinity);
console.log(`amKf max kpBegin: ${maxKp}`);

// For each artmesh, the deltas between consecutive kpBegins reveal slot stride.
console.log('\n== per-artmesh kpBegin deltas (first 3 slots each) ==');
let strideStats = { raw2vc: 0, padded16: 0, other: 0 };
for (let m = 0; m < Math.min(c.artMeshes, 40); m++) {
    const n = Math.min(amKsc[m], 3);
    const deltas = [];
    for (let k = 1; k < n; k++) deltas.push(amKp[amKsbi[m] + k] - amKp[amKsbi[m] + k - 1]);
    const expectedRaw = amVc[m] * 2;
    const expectedPad = Math.ceil(expectedRaw / 16) * 16;
    if (deltas.length > 0) {
        if (deltas.every((d) => d === expectedRaw)) strideStats.raw2vc++;
        else if (deltas.every((d) => d === expectedPad)) strideStats.padded16++;
        else strideStats.other++;
    }
    console.log(`mesh ${m} vc=${amVc[m]} ksc=${amKsc[m]} ksbi=${amKsbi[m]} kp0=${amKp[amKsbi[m]]} deltas=${JSON.stringify(deltas)} (raw=${expectedRaw} pad16=${expectedPad})`);
}
console.log('stride stats over first 40 meshes:', JSON.stringify(strideStats));

console.log('\n== params ==');
const paramIds = ia('params.ids', c.parameters).map((_, i) => id(target('params.ids') + i * 64));
const pbsbi = ia('params.pbsbi', c.parameters);
const pbsc = ia('params.pbsc', c.parameters);
const decimals = ia('params.decimals', c.parameters);
const pmin = ia('params.min', c.parameters, f32);
const pmax = ia('params.max', c.parameters, f32);
const pdef = ia('params.default', c.parameters, f32);
console.log(`params: ${c.parameters}, pbsc sum: ${pbsc.reduce((a, b) => a + b, 0)} vs pbi: ${c.parameterBindingIndices}`);
console.log('decimals unique:', [...new Set(decimals)]);
console.log('params [id min def max decimals pbsbi pbsc]:');
for (let p = 0; p < c.parameters; p++) console.log(`  ${paramIds[p]} ${pmin[p]} ${pdef[p]} ${pmax[p]} dec=${decimals[p]} pbsbi=${pbsbi[p]} pbsc=${pbsc[p]}`);

console.log('\n== keyform bindings ==');
const kbBegins = ia('kb.pbisbi', c.keyformBindings);
const kbCounts = ia('kb.pbisc', c.keyformBindings);
console.log(`kb: ${c.keyformBindings}, kbCounts sum: ${kbCounts.reduce((a, b) => a + b, 0)} vs pbi: ${c.parameterBindingIndices}`);
const pbi = ia('pbi.bindingSourcesIndices', c.parameterBindingIndices);
const pbKeysBegins = ia('pb.keysBegins', c.parameterBindings);
const pbKeysCounts = ia('pb.keysCounts', c.parameterBindings);
const seen = new Set();
for (let k = 0; k < c.keyformBindings; k++) {
    const sig = pbi.slice(kbBegins[k], kbBegins[k] + kbCounts[k]).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    if (seen.size <= 20) {
        const axes = sig.split(',').filter((s) => s !== '').map((s) => paramIds[s]);
        const keyLists = [...sig.split(',').filter((s) => s !== '')].map((pi) => {
            const count = pbKeysCounts[pi];
            return Array.from({ length: count }, (_, i) => f32(target('keys.values') + (pbKeysBegins[pi] + i) * 4));
        });
        console.log(`kb ${k} axes=[${axes}] keyValues=${JSON.stringify(keyLists)}`);
    }
}

console.log('\n== rotation deformer keyforms ==');
console.log(`rotation deformers: ${c.rotation}, rotKf: ${c.rotationDeformerKeyforms}`);
if (c.rotation > 0) {
    const rotKsbi = ia('rotation.ksbi', c.rotation);
    const rotKsc = ia('rotation.ksc', c.rotation);
    const rotAngles = ia('rotKf.angles', c.rotationDeformerKeyforms, f32);
    const rotKp = ia('rotKf.angles', 0);
    console.log(`rot ksbi[:6]: ${JSON.stringify(rotKsbi.slice(0, 6))} ksc[:6]: ${JSON.stringify(rotKsc.slice(0, 6))}`);
    console.log(`rotKf angles[:${Math.min(9, rotAngles.length)}]: ${JSON.stringify(rotAngles.slice(0, 9))}`);
}

console.log('\n== canvas ==');
const canvas = target('canvas');
console.log('ppu:', f32(canvas), 'origin:', f32(canvas + 4), f32(canvas + 8), 'size:', f32(canvas + 12), f32(canvas + 16), 'flags:', bytes[canvas + 20]);
