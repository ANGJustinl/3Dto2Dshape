// Dev tool: rebuilds an exported .moc3 with the binding-layer conventions
// the VTS sample models use, keeping the angle tensors:
//   - one parameterBinding PER PARAM (pbsbi = param order, pbsc = 1),
//     shared by every artmesh's pool reference
//   - one shared keyformBinding per distinct bound-param-set
//   - decimals = 3 on every parameter (samples carry 3; we wrote 0)
//   - kpBegins float offsets aligned to 16-float strides in a rebuilt,
//     padded kfPos pool
// Usage: node scripts/clone-sample-bindings.mjs <in.moc3> <out.moc3> [--first-outer]
//   --first-outer: enumerate tensor slots with pool axis 0 slowest instead
//   of fastest (A/B probe for the native Core's reading order).
import { readFileSync, writeFileSync } from 'node:fs';
import { readMoc3 } from './moc3-reader.mjs';

const FIRST_OUTER = process.argv.includes('--first-outer');
const ALL_PARAMS = process.argv.includes('--all-params');
const m = readMoc3(process.argv[2]);
const N = m.c.artMeshes;
const ANGLES = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const MORPH_REST_DIGIT = (id) => (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen' ? 1 : 0);

// Source slot: the input file's own enumeration over ALL its axes. The
// pre-fix export enumerates FIRST-outer over ascending param indices; the
// post-fix file enumerates LAST-outer with morph middle/top swapped.
const SOURCE_FIRST_OUTER = process.argv.includes('--source-first-outer');
const sourceSlot = (amIndex, digits) => {
    const radices = m.bindings[amIndex].map((b) => b.values.length);
    const ds = m.bindings[amIndex].map((b) => digits.get(b.paramId) ?? b.neutralIndex);
    let slot = 0;
    if (SOURCE_FIRST_OUTER) {
        let stride = radices.slice(1).reduce((p, r) => p * r, 1);
        radices.forEach((r, i) => {
            slot += ds[i] * stride;
            stride = Math.floor(stride / (radices[i + 1] ?? 1));
        });
    } else {
        let stride = 1;
        radices.forEach((r, i) => {
            slot += ds[i] * stride;
            stride *= r;
        });
    }
    return slot;
};

const plans = m.am.ids.map((_id, am) => {
    if (ALL_PARAMS) return m.bindings[am].slice(0, 5);
    return m.bindings[am].filter((b) => ANGLES.includes(b.paramId)).slice(0, 3);
});
const boundAms = plans.map((kept, am) => (kept.length > 0 ? am : -1)).filter((v) => v >= 0);

// One pb per param (all params, so every param owns exactly one binding as
// in the samples), with that param's original key values.
const pbParam = []; // new pb -> param index
const newKeys = [];
const newPbKeysBegins = [];
const newPbKeysCounts = [];
let keyCursor = 0;
m.params.ids.forEach((_id, p) => {
    const pbIndex = pbParam.length;
    pbParam.push(p);
    // Angle keys from any artmesh's binding for the param; morph keys from
    // the file's (unbound-now) param — fall back to its min/default/max.
    let values = null;
    for (const am of boundAms) {
        const hit = m.bindings[am].find((b) => b.paramIndex === p);
        if (hit) { values = hit.values; break; }
    }
    if (!values) values = [...new Set([m.params.min[p], m.params.def[p], m.params.max[p]])].sort((a, b) => a - b);
    newPbKeysBegins.push(keyCursor);
    newPbKeysCounts.push(values.length);
    values.forEach((v) => newKeys.push(v));
    keyCursor += values.length;
});

// One shared keyformBinding per distinct bound-param-set; kb[0] stays the
// shared empty binding, as in the sample models.
const newKbBegins = [0];
const newKbCounts = [0];
const newPbi = [];
const newAmKbsi = new Array(N).fill(0);
const kbBySet = new Map();
plans.forEach((kept, am) => {
    if (kept.length === 0) return;
    const key = kept.map((b) => b.paramIndex).join(',');
    let kb = kbBySet.get(key);
    if (kb === undefined) {
        kb = newKbBegins.length;
        kbBySet.set(key, kb);
        newKbBegins.push(newPbi.length);
        newKbCounts.push(kept.length);
        kept.forEach((b) => newPbi.push(pbParam.indexOf(b.paramIndex)));
    }
    newAmKbsi[am] = kb;
});

// Enumerate slots last-outer over the kept axes; rebuild the kfPos pool
// with 16-float aligned strides.
const newKpBegins = [];
const newOpacities = [];
const newDrawOrders = [];
const newKsbi = new Array(N).fill(0);
const newKsc = new Array(N).fill(1);
const poolChunks = [];
let poolCursor = 0;
let rowCursor = 0;
plans.forEach((kept, am) => {
    const verts = m.am.vertexCounts[am];
    const stride = Math.ceil((verts * 2) / 16) * 16;
    const rows = [];
    if (kept.length === 0) {
        rows.push(m.am.ksbi[am] + m.neutralSlot(am));
    } else {
        const total = kept.reduce((p, b) => p * b.values.length, 1);
        const radices = kept.map((b) => b.values.length);
        for (let linear = 0; linear < total; linear += 1) {
            const digits = new Map();
            let rest = linear;
            if (FIRST_OUTER) {
                // axis 0 slowest: digit_0 = linear / prod(radix_1..), etc.
                let divisor = radices.slice(1).reduce((p, r) => p * r, 1);
                kept.forEach((binding, axis) => {
                    digits.set(binding.paramId, Math.floor(rest / divisor) % radices[axis]);
                    divisor = Math.floor(divisor / (radices[axis + 1] ?? 1));
                });
            } else {
                kept.forEach((binding) => {
                    digits.set(binding.paramId, rest % binding.values.length);
                    rest = Math.floor(rest / binding.values.length);
                });
            }
            rows.push(m.am.ksbi[am] + sourceSlot(am, digits));
        }
    }
    newKsbi[am] = rowCursor;
    newKsc[am] = rows.length;
    rows.forEach((sourceRow) => {
        const sourceBase = m.view.getInt32(m.slot('amKf.kpBegins') + sourceRow * 4, true) * 4;
        const chunk = Buffer.alloc(stride * 4);
        m.bytes.copy(chunk, 0, m.slot('kfPos.xys') + sourceBase, m.slot('kfPos.xys') + sourceBase + verts * 2 * 4);
        poolChunks.push(chunk);
        newKpBegins.push(poolCursor);
        newOpacities.push(m.view.getFloat32(m.slot('amKf.opacities') + sourceRow * 4, true));
        newDrawOrders.push(m.view.getFloat32(m.slot('amKf.drawOrders') + sourceRow * 4, true));
        poolCursor += stride;
        rowCursor += 1;
    });
});
const newKfPos = Buffer.concat(poolChunks);
const totalRows = rowCursor;

// params slices: 1:1.
const newPbsbi = m.params.ids.map((_id, p) => pbParam.indexOf(p));
const newPbsc = m.params.ids.map(() => 1);

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

setSlot('countInfo', append(() => {
    [
        N, 0, 0, 0, N, m.c.parameters, N, 0, 0,
        totalRows,
        poolCursor, // padded pool floats
        newPbi.length,
        newKbBegins.length,
        pbParam.length,
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
setSlot('params.repeat', append(() => m.params.repeat.forEach(() => s32w(0))));
setSlot('params.decimals', append(() => m.params.decimals.forEach(() => s32w(3))));
setSlot('params.pbsbi', append(() => newPbsbi.forEach((v) => s32w(v))));
setSlot('params.pbsc', append(() => newPbsc.forEach((v) => s32w(v))));
copyF('partKf.drawOrders', N);
setSlot('amKf.opacities', append(() => newOpacities.forEach((v) => f32w(v))));
setSlot('amKf.drawOrders', append(() => newDrawOrders.forEach((v) => f32w(v))));
setSlot('amKf.kpBegins', append(() => newKpBegins.forEach((v) => s32w(v))));
setSlot('kfPos.xys', append(() => rawBytes(newKfPos)));
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
console.log(`sample-clone: rows ${m.c.artMeshKeyforms} -> ${totalRows}, pbs ${m.c.parameterBindings} -> ${pbParam.length} (1/param), kbs -> ${newKbBegins.length}, keys -> ${keyCursor}, kfPos floats -> ${poolCursor}; file ${result.length} bytes`);
