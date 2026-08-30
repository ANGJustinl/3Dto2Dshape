// Dev tool: rebuilds an exported .moc3 with every tensor reduced to the
// angle axes only (max 3 params, like the sample models' face tensors);
// morph params (eye/mouth) stay defined but bind nothing. Discriminates
// whether VTube Studio's native Core diverges from the Web Core on
// higher-order or morph-mixed tensors.
// Usage: node scripts/reduce-moc3-tensors.mjs <in.moc3> <out.moc3> [--static]
//   --static: strip ALL bindings; every artmesh keeps only its neutral
//   keyform (a pure static model, the maximally-conservative variant).
import { readFileSync, writeFileSync } from 'node:fs';
import { readMoc3 } from './moc3-reader.mjs';

const STATIC = process.argv.includes('--static');
const m = readMoc3(process.argv[2]);
const N = m.c.artMeshes;
const ANGLES = new Set(['ParamAngleX', 'ParamAngleY', 'ParamAngleZ']);
const MORPH_REST_DIGIT = (id) => (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen' ? 1 : 0);

// Original (post-fix) slot layout: last-outer over the binding pool, with
// morph middle/top digits swapped. A source slot for target angle digits:
// morph axes pinned at their rest digit.
const sourceSlot = (amIndex, angleDigits) => {
    let slot = 0;
    let stride = 1;
    m.bindings[amIndex].forEach((binding) => {
        const digit = ANGLES.has(binding.paramId)
            ? angleDigits.get(binding.paramId) ?? binding.neutralIndex
            : MORPH_REST_DIGIT(binding.paramId);
        slot += digit * stride;
        stride *= binding.values.length;
    });
    return slot;
};

// Per-artmesh plan: kept angle axes (in pool order) and their key values.
const plans = m.am.ids.map((_id, am) => {
    if (STATIC) return [];
    const kept = m.bindings[am].filter((b) => ANGLES.has(b.paramId)).slice(0, 3);
    return kept;
});

// New amKf rows: for each artmesh, enumerate kept axes last-outer and copy
// the source row's kpBegins/opacities/drawOrders.
const newKpBegins = [];
const newOpacities = [];
const newDrawOrders = [];
const rowSources = []; // per artmesh: array of source rows
let rowCursor = 0;
const newKsbi = new Array(N).fill(0);
const newKsc = new Array(N).fill(1);
plans.forEach((kept, am) => {
    if (kept.length === 0) {
        // Unbound: single neutral row (source neutral slot).
        const slot = m.neutralSlot(am);
        rowSources.push([m.am.ksbi[am] + slot]);
        newKsbi[am] = rowCursor;
        newKsc[am] = 1;
        rowCursor += 1;
        return;
    }
    const radices = kept.map((b) => b.values.length);
    const total = radices.reduce((p, r) => p * r, 1);
    const rows = [];
    for (let linear = 0; linear < total; linear += 1) {
        const angleDigits = new Map();
        let rest = linear;
        kept.forEach((binding) => {
            const radix = binding.values.length;
            angleDigits.set(binding.paramId, rest % radix);
            rest = Math.floor(rest / radix);
        });
        rows.push(m.am.ksbi[am] + sourceSlot(am, angleDigits));
    }
    rowSources.push(rows);
    newKsbi[am] = rowCursor;
    newKsc[am] = total;
    rowCursor += total;
});
rowSources.forEach((rows) => {
    rows.forEach((row) => {
        newKpBegins.push(m.view.getInt32(m.slot('amKf.kpBegins') + row * 4, true));
        newOpacities.push(m.view.getFloat32(m.slot('amKf.opacities') + row * 4, true));
        newDrawOrders.push(m.view.getFloat32(m.slot('amKf.drawOrders') + row * 4, true));
    });
});

// Binding graph: kb[0] shared empty; bound artmeshes get one kb with their
// kept angle pbs. pb array keeps ONLY the pbs referenced by kept axes,
// renumbered; param-major over the remaining angle params.
const keptPbByOld = new Map(); // old pb -> new pb
plans.forEach((kept, am) => kept.forEach((binding) => keptPbByOld.set(binding.pb, null)));
// param-major ordering: sort kept pbs by (param index, old pb)
const paramOrder = (pb) => {
    const owner = m.pbOwner[pb];
    return owner * 1000000 + pb;
};
const newPbList = [...keptPbByOld.keys()].sort((a, b) => paramOrder(a) - paramOrder(b));
newPbList.forEach((oldPb, index) => keptPbByOld.set(oldPb, index));

const newPbKeysBegins = [];
const newPbKeysCounts = [];
const newKeys = [];
let keyCursor = 0;
newPbList.forEach((oldPb) => {
    const count = m.pbKeysCounts[oldPb];
    newPbKeysBegins.push(keyCursor);
    newPbKeysCounts.push(count);
    for (let i = 0; i < count; i += 1) {
        newKeys.push(m.view.getFloat32(m.slot('keys.values') + (m.pbKeysBegins[oldPb] + i) * 4, true));
    }
    keyCursor += count;
});

// pbi pool + kb arrays (kb[0] = {0,0} empty).
const newPbi = [];
const newKbBegins = [0];
const newKbCounts = [0];
const newAmKbsi = new Array(N).fill(0);
plans.forEach((kept, am) => {
    if (kept.length === 0) return;
    const kbIndex = newKbBegins.length;
    newAmKbsi[am] = kbIndex;
    newKbBegins.push(newPbi.length);
    newKbCounts.push(kept.length);
    kept.forEach((binding) => newPbi.push(keptPbByOld.get(binding.pb)));
});

// params slices: angle params own their (renumbered) pbs; morph params none.
const newPbsbi = new Array(m.c.parameters).fill(0);
const newPbsc = new Array(m.c.parameters).fill(0);
newPbList.forEach((oldPb, newPb) => {
    const owner = m.pbOwner[oldPb];
    if (newPbsc[owner] === 0) newPbsbi[owner] = newPb;
    newPbsc[owner] += 1;
});

const totalRows = newKpBegins.length;

// ---- Canonical serializer ----
const f32r = (o) => m.view.getFloat32(o, true);
const s32r = (o) => m.view.getInt32(o, true);
const u32r = (o) => m.view.getUint32(o, true);
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
const append = (write) => { align64(); const start = length; write(); return start; };

const NAMES = ['countInfo','canvas','parts.runtime0','parts.ids','parts.kbsi','parts.ksbi','parts.ksc','parts.visible','parts.enabled','parts.parentPart','deformers.runtime0','deformers.ids','deformers.kbsi','deformers.visible','deformers.enabled','deformers.parentPart','deformers.parentDeformer','deformers.types','deformers.specificSources','warp.kbsi','warp.ksbi','warp.ksc','warp.vertexCounts','warp.rows','warp.columns','rotation.kbsi','rotation.ksbi','rotation.ksc','rotation.baseAngles','am.runtime0','am.runtime1','am.runtime2','am.runtime3','am.ids','am.kbsi','am.ksbi','am.ksc','am.visible','am.enabled','am.parentPart','am.parentDeformer','am.textureNos','am.flags','am.vertexCounts','am.uvBegins','am.piBegins','am.piCounts','am.maskBegins','am.maskCounts','params.runtime0','params.ids','params.max','params.min','params.default','params.repeat','params.decimals','params.pbsbi','params.pbsc','partKf.drawOrders','warpKf.opacities','warpKf.kpBegins','rotKf.opacities','rotKf.angles','rotKf.originX','rotKf.originY','rotKf.scales','rotKf.reflectX','rotKf.reflectY','amKf.opacities','amKf.drawOrders','amKf.kpBegins','kfPos.xys','pbi.bindingSourcesIndices','kb.pbisbi','kb.pbisc','pb.keysBegins','pb.keysCounts','keys.values','uv.uvs','pi.indices','masks.artMeshSourcesIndices','groups.objBegins','groups.objCounts','groups.objTotalCounts','groups.maxDrawOrders','groups.minDrawOrders','groupObjects.types','groupObjects.indices','groupObjects.selfIndices','glue.runtime0','glue.ids','glue.kbsi','glue.ksbi','glue.ksc','glue.amA','glue.amB','glue.infoBegins','glue.infoCounts','glueInfo.weights','glueInfo.positionIndices','glueKf.intensities'];
const targets = new Array(101).fill(-1);
const setSlot = (name, target) => { targets[NAMES.indexOf(name)] = target; };

rawBytes(Buffer.from([0x4d, 0x4f, 0x43, 0x33, 1, 0]));
while (length < 0x40) u8(0);
const slotPos = [];
for (let i = 0; i < 101; i += 1) { slotPos.push(length); u32w(0); }
while (length < 0x7c0) u8(0);

// count table (rewritten totals)
setSlot('countInfo', append(() => {
    [
        N, 0, 0, 0, N, m.c.parameters, N, 0, 0,
        totalRows,
        m.c.keyformPositions, // pool unchanged (rows reuse source floats)
        newPbi.length,
        newKbBegins.length,
        newPbList.length,
        keyCursor,
        m.c.uvs, m.c.positionIndices, 0, 1, N, 0, 0, 0,
    ].forEach((v) => u32w(v));
    for (let i = 0; i < 128 - 23 * 4; i += 1) u8(0);
}));
setSlot('canvas', append(() => rawBytes(m.bytes.subarray(m.slot('canvas'), m.slot('canvas') + 64))));

const copyS = (name, count) => setSlot(name, append(() => { for (let i = 0; i < count; i += 1) s32w(s32r(m.slot(name) + i * 4)); }));
const copyU = (name, count) => setSlot(name, append(() => { for (let i = 0; i < count; i += 1) u32w(u32r(m.slot(name) + i * 4)); }));
const copyF = (name, count) => setSlot(name, append(() => { for (let i = 0; i < count; i += 1) f32w(f32r(m.slot(name) + i * 4)); }));
const copyIds = (name, count) => setSlot(name, append(() => rawBytes(m.bytes.subarray(m.slot(name), m.slot(name) + count * 64))));

setSlot('parts.runtime0', append(() => { for (let i = 0; i < N * 8; i += 1) u8(0); }));
copyIds('parts.ids', N);
copyS('parts.kbsi', N); copyS('parts.ksbi', N); copyS('parts.ksc', N);
copyU('parts.visible', N); copyU('parts.enabled', N); copyS('parts.parentPart', N);
for (const rt of ['am.runtime0', 'am.runtime1', 'am.runtime2', 'am.runtime3']) {
    setSlot(rt, append(() => { for (let i = 0; i < N * 8; i += 1) u8(0); }));
}
copyIds('am.ids', N);
setSlot('am.kbsi', append(() => newAmKbsi.forEach((v) => s32w(v))));
setSlot('am.ksbi', append(() => newKsbi.forEach((v) => s32w(v))));
setSlot('am.ksc', append(() => newKsc.forEach((v) => s32w(v))));
copyU('am.visible', N); copyU('am.enabled', N); copyS('am.parentPart', N); copyS('am.parentDeformer', N);
copyU('am.textureNos', N);
setSlot('am.flags', append(() => { for (let i = 0; i < N; i += 1) u8(m.bytes[m.slot('am.flags') + i]); }));
copyS('am.vertexCounts', N); copyS('am.uvBegins', N); copyS('am.piBegins', N); copyS('am.piCounts', N);
copyS('am.maskBegins', N); copyS('am.maskCounts', N);
setSlot('params.runtime0', append(() => { for (let i = 0; i < m.c.parameters * 8; i += 1) u8(0); }));
copyIds('params.ids', m.c.parameters);
copyF('params.max', m.c.parameters); copyF('params.min', m.c.parameters); copyF('params.default', m.c.parameters);
copyS('params.repeat', m.c.parameters); copyS('params.decimals', m.c.parameters);
setSlot('params.pbsbi', append(() => newPbsbi.forEach((v) => s32w(v))));
setSlot('params.pbsc', append(() => newPbsc.forEach((v) => s32w(v))));
copyF('partKf.drawOrders', N);
setSlot('amKf.opacities', append(() => newOpacities.forEach((v) => f32w(v))));
setSlot('amKf.drawOrders', append(() => newDrawOrders.forEach((v) => f32w(v))));
setSlot('amKf.kpBegins', append(() => newKpBegins.forEach((v) => s32w(v))));
setSlot('kfPos.xys', append(() => rawBytes(m.bytes.subarray(m.slot('kfPos.xys'), m.slot('kfPos.xys') + m.c.keyformPositions * 4))));
setSlot('pbi.bindingSourcesIndices', append(() => newPbi.forEach((v) => s32w(v))));
setSlot('kb.pbisbi', append(() => newKbBegins.forEach((v) => s32w(v))));
setSlot('kb.pbisc', append(() => newKbCounts.forEach((v) => s32w(v))));
setSlot('pb.keysBegins', append(() => newPbKeysBegins.forEach((v) => s32w(v))));
setSlot('pb.keysCounts', append(() => newPbKeysCounts.forEach((v) => s32w(v))));
setSlot('keys.values', append(() => newKeys.forEach((v) => f32w(v))));
copyF('uv.uvs', m.c.uvs);
setSlot('pi.indices', append(() => {
    for (let i = 0; i < m.c.positionIndices; i += 1) {
        const o = m.slot('pi.indices') + i * 2;
        s16w(o + 2 <= m.bytes.length ? m.view.getInt16(o, true) : 0);
    }
}));
copyS('groups.objBegins', 1); copyS('groups.objCounts', 1); copyS('groups.objTotalCounts', 1);
copyU('groups.maxDrawOrders', 1); copyU('groups.minDrawOrders', 1);
copyU('groupObjects.types', N); copyS('groupObjects.indices', N); copyS('groupObjects.selfIndices', N);

align64();
const fileEnd = length;
let nextTarget = fileEnd;
for (let i = 100; i >= 0; i -= 1) {
    if (targets[i] >= 0) nextTarget = targets[i];
    else targets[i] = nextTarget;
}
targets.forEach((target, index) => out.writeUInt32LE(target >>> 0, slotPos[index]));

const result = out.subarray(0, length);
writeFileSync(process.argv[3], result);
console.log(`reduced: artMeshKeyforms ${m.c.artMeshKeyforms} -> ${totalRows}, pbs ${m.c.parameterBindings} -> ${newPbList.length}, keys ${m.c.keys} -> ${keyCursor}; file ${result.length} bytes`);
