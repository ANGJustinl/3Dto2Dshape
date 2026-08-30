// Dev tool: adds an identity rotation-deformer layer to a moc3 whose
// artmeshes hang directly on parts (parentDeformer = -1) AND re-emits the
// whole file in the canonical Cubism layout (64-aligned sections in slot
// order, id arrays trailing their runtime arrays, exact total size), which
// csmHasMocConsistency requires. One identity rotation deformer per part
// (angle 0, opacity 1, scale 1, empty binding), artmesh d -> deformer d.
// Usage: node scripts/add-deformers.mjs <in.moc3> <out.moc3>
import { readFileSync, writeFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (o) => view.getUint32(o, true);
const S = ['countInfo','canvas','parts.runtime0','parts.ids','parts.kbsi','parts.ksbi','parts.ksc','parts.visible','parts.enabled','parts.parentPart','deformers.runtime0','deformers.ids','deformers.kbsi','deformers.visible','deformers.enabled','deformers.parentPart','deformers.parentDeformer','deformers.types','deformers.specificSources','warp.kbsi','warp.ksbi','warp.ksc','warp.vertexCounts','warp.rows','warp.columns','rotation.kbsi','rotation.ksbi','rotation.ksc','rotation.baseAngles','am.runtime0','am.runtime1','am.runtime2','am.runtime3','am.ids','am.kbsi','am.ksbi','am.ksc','am.visible','am.enabled','am.parentPart','am.parentDeformer','am.textureNos','am.flags','am.vertexCounts','am.uvBegins','am.piBegins','am.piCounts','am.maskBegins','am.maskCounts','params.runtime0','params.ids','params.max','params.min','params.default','params.repeat','params.decimals','params.pbsbi','params.pbsc','partKf.drawOrders','warpKf.opacities','warpKf.kpBegins','rotKf.opacities','rotKf.angles','rotKf.originX','rotKf.originY','rotKf.scales','rotKf.reflectX','rotKf.reflectY','amKf.opacities','amKf.drawOrders','amKf.kpBegins','kfPos.xys','pbi.bindingSourcesIndices','kb.pbisbi','kb.pbisc','pb.keysBegins','pb.keysCounts','keys.values','uv.uvs','pi.indices','masks.artMeshSourcesIndices','groups.objBegins','groups.objCounts','groups.objTotalCounts','groups.maxDrawOrders','groups.minDrawOrders','groupObjects.types','groupObjects.indices','groupObjects.selfIndices','glue.runtime0','glue.ids','glue.kbsi','glue.ksbi','glue.ksc','glue.amA','glue.amB','glue.infoBegins','glue.infoCounts','glueInfo.weights','glueInfo.positionIndices','glueKf.intensities'];
const T = (name) => u32(0x40 + S.indexOf(name) * 4);
const countInfo = T('countInfo');
const counts = Array.from({ length: 23 }, (_, i) => u32(countInfo + i * 4));
const cP = counts[0];
const cAm = counts[4];
if (cP !== cAm) throw new Error(`expected one part per artmesh (${cP} vs ${cAm})`);

// ---- build the NEW deformer-layer section contents ----
const s32Buf = (values) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
    return b;
};
const f32Buf = (values) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeFloatLE(v, i * 4));
    return b;
};
const newSections = new Map();
newSections.set('deformers.runtime0', Buffer.alloc(cAm * 8));
{
    const ids = Buffer.alloc(cAm * 64);
    for (let d = 0; d < cAm; d += 1) ids.write(`DeformRot${d}`, d * 64);
    newSections.set('deformers.ids', ids);
}
const KB = Number(process.env.KB_DEFORMER ?? 0); newSections.set('deformers.kbsi', s32Buf(Array(cAm).fill(KB)));
newSections.set('deformers.visible', s32Buf(Array(cAm).fill(1)));
newSections.set('deformers.enabled', s32Buf(Array(cAm).fill(1)));
newSections.set('deformers.parentPart', s32Buf(Array.from({ length: cAm }, (_, d) => d)));
newSections.set('deformers.parentDeformer', s32Buf(Array(cAm).fill(-1)));
newSections.set('deformers.types', s32Buf(Array(cAm).fill(1)));
newSections.set('deformers.specificSources', s32Buf(Array.from({ length: cAm }, (_, d) => d)));
newSections.set('rotation.kbsi', s32Buf(Array(cAm).fill(0)));
newSections.set('rotation.ksbi', s32Buf(Array.from({ length: cAm }, (_, d) => d)));
const KSC = Number(process.env.ROT_KSC ?? 1); newSections.set('rotation.ksc', s32Buf(Array(cAm).fill(KSC)));
newSections.set('rotation.baseAngles', f32Buf(Array(cAm).fill(0)));
newSections.set('rotKf.opacities', f32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(1)));
newSections.set('rotKf.angles', f32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(0)));
newSections.set('rotKf.originX', f32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(0)));
newSections.set('rotKf.originY', f32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(0)));
newSections.set('rotKf.scales', f32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(1)));
newSections.set('rotKf.reflectX', s32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(0)));
newSections.set('rotKf.reflectY', s32Buf(Array(cAm * (process.env.ROT_KSC ? Number(process.env.ROT_KSC) : 1)).fill(0)));

// artmesh parentDeformer d (replaces the -1 column)
{
    const col = Buffer.alloc(cAm * 4);
    for (let m = 0; m < cAm; m += 1) col.writeInt32LE(m, m * 4);
    newSections.set('am.parentDeformer', col);
}

// ---- section size table (counts field index, element bytes) ----
const F = { parts: 0, deformers: 1, warp: 2, rotation: 3, artMeshes: 4, parameters: 5, partKeyforms: 6, warpDeformerKeyforms: 7, rotationDeformerKeyforms: 8, artMeshKeyforms: 9, keyformPositions: 10, parameterBindingIndices: 11, keyformBindings: 12, parameterBindings: 13, keys: 14, uvs: 15, positionIndices: 16, drawableMasks: 17, drawOrderGroups: 18, drawOrderGroupObjects: 19, glue: 20, glueInfo: 21, glueKeyforms: 22 };
const LAYOUT = [];
const add = (slot, field, elem, followRuntime = false) => LAYOUT.push({ slot, field, elem, followRuntime });
add(2, 'parts', 8); add(3, 'parts', 64, true);
for (let s = 4; s <= 9; s++) add(s, 'parts', 4);
add(10, 'deformers', 8); add(11, 'deformers', 64, true);
for (let s = 12; s <= 18; s++) add(s, 'deformers', 4);
for (let s = 19; s <= 24; s++) add(s, 'warp', 4);
for (let s = 25; s <= 28; s++) add(s, 'rotation', 4);
for (let s = 29; s <= 32; s++) add(s, 'artMeshes', 8);
add(33, 'artMeshes', 64, true);
for (let s = 34; s <= 41; s++) add(s, 'artMeshes', 4);
add(42, 'artMeshes', 1);
for (let s = 43; s <= 48; s++) add(s, 'artMeshes', 4);
add(49, 'parameters', 8); add(50, 'parameters', 64, true);
for (let s = 51; s <= 57; s++) add(s, 'parameters', 4);
add(58, 'partKeyforms', 4);
add(59, 'warpDeformerKeyforms', 4); add(60, 'warpDeformerKeyforms', 4);
for (let s = 61; s <= 67; s++) add(s, 'rotationDeformerKeyforms', 4);
for (let s = 68; s <= 70; s++) add(s, 'artMeshKeyforms', 4);
add(71, 'keyformPositions', 4);
add(72, 'parameterBindingIndices', 4);
add(73, 'keyformBindings', 4); add(74, 'keyformBindings', 4);
add(75, 'parameterBindings', 4); add(76, 'parameterBindings', 4);
add(77, 'keys', 4); add(78, 'uvs', 4); add(79, 'positionIndices', 2); add(80, 'drawableMasks', 4);
add(81, 'drawOrderGroups', 4); add(82, 'drawOrderGroups', 4); add(83, 'drawOrderGroups', 4);
add(84, 'drawOrderGroupObjects', 4); add(85, 'drawOrderGroupObjects', 4);
for (let s = 86; s <= 88; s++) add(s, 'drawOrderGroupObjects', 4);
add(89, 'glue', 8); add(90, 'glue', 64, true);
for (let s = 91; s <= 97; s++) add(s, 'glue', 4);
add(98, 'glueInfo', 4); add(99, 'glueInfo', 4); add(100, 'glueKeyforms', 4);

// ---- copy existing section contents by pointer, using the size table ----
const readSection = (slot, field, elem) => {
    const count = counts[F[field]];
    const size = count * elem;
    const ptr = u32(0x40 + slot * 4);
    if (ptr === 0 || ptr === bytes.length) return Buffer.alloc(size);
    return bytes.subarray(ptr, ptr + size);
};

const align64 = (v) => Math.ceil(v / 64) * 64;
let cursor = 0x7c0;
const plan = [];
const emit = (slot, data) => {
    const entry = LAYOUT.find((l) => l.slot === slot);
    if (entry && !entry.followRuntime) cursor = align64(cursor);
    plan.push({ slot, target: cursor, data });
    cursor += data.length;
};
emit(0, bytes.subarray(countInfo, countInfo + 128));
emit(1, bytes.subarray(T('canvas'), T('canvas') + 64));
for (const { slot, field, elem } of LAYOUT) {
    const data = newSections.get(S[slot]) ?? readSection(slot, field, elem);
    emit(slot, Buffer.from(data));
}
const totalSize = align64(cursor);
const out = Buffer.alloc(totalSize);
out.write('MOC3', 0, 'latin1');
out[4] = bytes[4];
for (const { slot, target, data } of plan) {
    out.writeUInt32LE(target, 0x40 + slot * 4);
    data.copy(out, target);
}
counts.forEach((c, i) => out.writeUInt32LE(c, countInfoTarget(plan) + i * 4));
function countInfoTarget(plan) {
    return plan.find((p) => p.slot === 0).target;
}

writeFileSync(process.argv[3], out);
console.log(`written ${process.argv[3]} (${out.length} bytes); ${cAm} identity rotation deformers added, canonical layout`);
