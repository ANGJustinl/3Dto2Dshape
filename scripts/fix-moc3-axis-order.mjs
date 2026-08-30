// Dev tool: repairs an exported .moc3 whose tensor keyforms were enumerated
// first-outer (axis 0 slowest) while the Cubism Core reads them LAST-OUTER
// (axis 0 fastest — verified against the real Core's parameter response).
// Re-permutes each artmesh's keyform order (kpBegins + amKf rows) and
// re-serializes the whole file canonically, which also restores the
// truncated positionIndices tail of the last drawable.
// Usage: node scripts/fix-moc3-axis-order.mjs <in.moc3> <out.moc3>
import { readFileSync, writeFileSync } from 'node:fs';
import { readMoc3 } from './moc3-reader.mjs';

const m = readMoc3(process.argv[2]);
const N = m.c.artMeshes;

// ---- Read every array we must carry over, in slot order ----
const f32 = (o) => m.view.getFloat32(o, true);
const s32 = (o) => m.view.getInt32(o, true);
const u32 = (o) => m.view.getUint32(o, true);
const raw = (name, count, bytesPer) =>
    Buffer.from(m.bytes.subarray(m.slot(name), m.slot(name) + count * bytesPer));

// Per-artmesh keyform permutation: old slot -> new slot.
// Old digits (axis0 slowest): d0..dk with d0 most significant.
// New slot (axis0 fastest): sum d_i * prod(radix_j, j<i).
// Morph axes (eye/mouth) additionally swap digits 1<->2: the real Core
// evaluates value==1 onto the MIDDLE key of a [0,.5,1] morph axis (verified
// empirically), so the fully-open rest pose must live at digit 1.
const MORPH_PARAM_IDS = new Set(['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY']);
const newFromOld = (amIndex, oldSlot) => {
    const radices = m.bindings[amIndex].map((b) => b.values.length);
    if (radices.length === 0) return oldSlot;
    let rest = oldSlot;
    const digits = new Array(radices.length);
    for (let i = 0; i < radices.length; i += 1) {
        digits[i] = rest % radices[i];
        rest = Math.floor(rest / radices[i]);
    }
    m.bindings[amIndex].forEach((binding, i) => {
        if (MORPH_PARAM_IDS.has(binding.paramId) && digits[i] === 1) digits[i] = 2;
        else if (MORPH_PARAM_IDS.has(binding.paramId) && digits[i] === 2) digits[i] = 1;
    });
    let out = 0;
    let stride = 1;
    for (let i = 0; i < radices.length; i += 1) {
        out += digits[i] * stride;
        stride *= radices[i];
    }
    return out;
};

// amKf rows (opacities, drawOrders, kpBegins) permuted per artmesh.
const opacities = new Float32Array(m.c.artMeshKeyforms);
const drawOrders = new Float32Array(m.c.artMeshKeyforms);
const kpBegins = new Int32Array(m.c.artMeshKeyforms);
for (let am = 0; am < N; am += 1) {
    const ksc = m.am.ksc[am];
    const ksbi = m.am.ksbi[am];
    for (let oldSlot = 0; oldSlot < ksc; oldSlot += 1) {
        const row = ksbi + oldSlot;
        const newRow = ksbi + newFromOld(am, oldSlot);
        opacities[newRow] = f32(m.slot('amKf.opacities') + row * 4);
        drawOrders[newRow] = f32(m.slot('amKf.drawOrders') + row * 4);
        kpBegins[newRow] = s32(m.slot('amKf.kpBegins') + row * 4);
    }
}

// positionIndices: carry over; the last drawable's tail entries that the
// truncated source lacks become degenerate (0,0,0) triangles.
const pi = new Int16Array(m.c.positionIndices);
for (let i = 0; i < m.c.positionIndices; i += 1) {
    const o = m.slot('pi.indices') + i * 2;
    pi[i] = o + 2 <= m.bytes.length ? m.view.getInt16(o, true) : 0;
}

// ---- Canonical serializer (mirrors src/lib/live2d/moc3.ts) ----
const SLOT_COUNT = 101;
const targets = new Array(SLOT_COUNT).fill(-1);
const chunks = [];
let out = Buffer.alloc(1 << 20);
let length = 0;
const ensure = (extra) => {
    if (length + extra <= out.length) return;
    let cap = out.length;
    while (cap < length + extra) cap *= 2;
    const next = Buffer.alloc(cap);
    out.copy(next, 0, 0, length);
    out = next;
};
const u8 = (v) => { ensure(1); out.writeUInt8(v & 0xff, length); length += 1; };
const u32w = (v) => { ensure(4); out.writeUInt32LE(v >>> 0, length); length += 4; };
const s32w = (v) => { ensure(4); out.writeInt32LE(v | 0, length); length += 4; };
const f32w = (v) => { ensure(4); out.writeFloatLE(v, length); length += 4; };
const s16w = (v) => { ensure(2); out.writeInt16LE(v | 0, length); length += 2; };
const rawBytes = (b) => { ensure(b.length); b.copy(out, length); length += b.length; };
const align64 = () => { while (length % 64 !== 0) u8(0); };
const append = (write, followsRuntime = false) => {
    if (!followsRuntime) align64();
    const start = length;
    write();
    return start;
};
const S = (name) => ['countInfo','canvas','parts.runtime0','parts.ids','parts.kbsi','parts.ksbi','parts.ksc','parts.visible','parts.enabled','parts.parentPart','deformers.runtime0','deformers.ids','deformers.kbsi','deformers.visible','deformers.enabled','deformers.parentPart','deformers.parentDeformer','deformers.types','deformers.specificSources','warp.kbsi','warp.ksbi','warp.ksc','warp.vertexCounts','warp.rows','warp.columns','rotation.kbsi','rotation.ksbi','rotation.ksc','rotation.baseAngles','am.runtime0','am.runtime1','am.runtime2','am.runtime3','am.ids','am.kbsi','am.ksbi','am.ksc','am.visible','am.enabled','am.parentPart','am.parentDeformer','am.textureNos','am.flags','am.vertexCounts','am.uvBegins','am.piBegins','am.piCounts','am.maskBegins','am.maskCounts','params.runtime0','params.ids','params.max','params.min','params.default','params.repeat','params.decimals','params.pbsbi','params.pbsc','partKf.drawOrders','warpKf.opacities','warpKf.kpBegins','rotKf.opacities','rotKf.angles','rotKf.originX','rotKf.originY','rotKf.scales','rotKf.reflectX','rotKf.reflectY','amKf.opacities','amKf.drawOrders','amKf.kpBegins','kfPos.xys','pbi.bindingSourcesIndices','kb.pbisbi','kb.pbisc','pb.keysBegins','pb.keysCounts','keys.values','uv.uvs','pi.indices','masks.artMeshSourcesIndices','groups.objBegins','groups.objCounts','groups.objTotalCounts','groups.maxDrawOrders','groups.minDrawOrders','groupObjects.types','groupObjects.indices','groupObjects.selfIndices','glue.runtime0','glue.ids','glue.kbsi','glue.ksbi','glue.ksc','glue.amA','glue.amB','glue.infoBegins','glue.infoCounts','glueInfo.weights','glueInfo.positionIndices','glueKf.intensities'].indexOf(name);
const setSlot = (name, target) => { targets[S(name)] = target; };

// Header
rawBytes(Buffer.from([0x4d, 0x4f, 0x43, 0x33, 1, 0]));
while (length < 0x40) u8(0);
const slotPos = [];
for (let i = 0; i < SLOT_COUNT; i += 1) { slotPos.push(length); u32w(0); }
while (length < 0x7c0) u8(0);

const c = m.c;
// countInfo (fixed 128 bytes) + canvas carried verbatim.
setSlot('countInfo', append(() => rawBytes(m.bytes.subarray(m.slot('countInfo'), m.slot('countInfo') + 128))));
setSlot('canvas', append(() => rawBytes(m.bytes.subarray(m.slot('canvas'), m.slot('canvas') + 64))));

const copyS = (name, count) => setSlot(name, append(() => {
    for (let i = 0; i < count; i += 1) s32w(s32(m.slot(name) + i * 4));
}));
const copyU = (name, count) => setSlot(name, append(() => {
    for (let i = 0; i < count; i += 1) u32w(u32(m.slot(name) + i * 4));
}));
const copyF = (name, count) => setSlot(name, append(() => {
    for (let i = 0; i < count; i += 1) f32w(f32(m.slot(name) + i * 4));
}));
const copyIds = (name, count) => setSlot(name, append(() => {
    rawBytes(m.bytes.subarray(m.slot(name), m.slot(name) + count * 64));
}, true));

// parts
setSlot('parts.runtime0', append(() => { for (let i = 0; i < c.parts * 8; i += 1) u8(0); }));
copyIds('parts.ids', c.parts);
copyS('parts.kbsi', c.parts); copyS('parts.ksbi', c.parts); copyS('parts.ksc', c.parts);
copyU('parts.visible', c.parts); copyU('parts.enabled', c.parts); copyS('parts.parentPart', c.parts);

// artmeshes
for (const rt of ['am.runtime0', 'am.runtime1', 'am.runtime2', 'am.runtime3']) {
    setSlot(rt, append(() => { for (let i = 0; i < N * 8; i += 1) u8(0); }));
}
copyIds('am.ids', N);
copyS('am.kbsi', N); copyS('am.ksbi', N); copyS('am.ksc', N);
copyU('am.visible', N); copyU('am.enabled', N); copyS('am.parentPart', N); copyS('am.parentDeformer', N);
copyU('am.textureNos', N);
setSlot('am.flags', append(() => { for (let i = 0; i < N; i += 1) u8(m.bytes[m.slot('am.flags') + i]); }));
copyS('am.vertexCounts', N); copyS('am.uvBegins', N); copyS('am.piBegins', N); copyS('am.piCounts', N);
copyS('am.maskBegins', N); copyS('am.maskCounts', N);

// params
setSlot('params.runtime0', append(() => { for (let i = 0; i < c.parameters * 8; i += 1) u8(0); }));
copyIds('params.ids', c.parameters);
copyF('params.max', c.parameters); copyF('params.min', c.parameters); copyF('params.default', c.parameters);
copyS('params.repeat', c.parameters); copyS('params.decimals', c.parameters);
copyS('params.pbsbi', c.parameters); copyS('params.pbsc', c.parameters);

copyF('partKf.drawOrders', c.partKeyforms);

// amKf (permuted)
setSlot('amKf.opacities', append(() => { for (let i = 0; i < c.artMeshKeyforms; i += 1) f32w(opacities[i]); }));
setSlot('amKf.drawOrders', append(() => { for (let i = 0; i < c.artMeshKeyforms; i += 1) f32w(drawOrders[i]); }));
setSlot('amKf.kpBegins', append(() => { for (let i = 0; i < c.artMeshKeyforms; i += 1) s32w(kpBegins[i]); }));

// kfPos carried verbatim
setSlot('kfPos.xys', append(() => {
    rawBytes(m.bytes.subarray(m.slot('kfPos.xys'), m.slot('kfPos.xys') + c.keyformPositions * 4));
}));
copyS('pbi.bindingSourcesIndices', c.parameterBindingIndices);
copyS('kb.pbisbi', c.keyformBindings); copyS('kb.pbisc', c.keyformBindings);
copyS('pb.keysBegins', c.parameterBindings); copyS('pb.keysCounts', c.parameterBindings);
copyF('keys.values', c.keys);
copyF('uv.uvs', c.uvs);
setSlot('pi.indices', append(() => { for (let i = 0; i < c.positionIndices; i += 1) s16w(pi[i]); }));

// groups
copyS('groups.objBegins', c.drawOrderGroups); copyS('groups.objCounts', c.drawOrderGroups);
copyS('groups.objTotalCounts', c.drawOrderGroups);
copyU('groups.maxDrawOrders', c.drawOrderGroups); copyU('groups.minDrawOrders', c.drawOrderGroups);
copyU('groupObjects.types', c.drawOrderGroupObjects);
copyS('groupObjects.indices', c.drawOrderGroupObjects);
copyS('groupObjects.selfIndices', c.drawOrderGroupObjects);

align64();
const fileEnd = length;
let nextTarget = fileEnd;
for (let i = SLOT_COUNT - 1; i >= 0; i -= 1) {
    if (targets[i] >= 0) nextTarget = targets[i];
    else targets[i] = nextTarget;
}
targets.forEach((target, index) => out.writeUInt32LE(target >>> 0, slotPos[index]));

const result = out.subarray(0, length);
writeFileSync(process.argv[3], result);
console.log(`repaired: ${m.bytes.length} -> ${result.length} bytes; keyform rows permuted for last-outer enumeration`);
