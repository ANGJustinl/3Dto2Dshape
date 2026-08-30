// Dev tool: emits a minimal, canonical, deformer-less moc3 (1 part, 1
// artmesh of 4 vertices, 1 parameter, 1 neutral keyform, 1 draw-order
// group) so the native Core's InitializeModelInPlace can be validated
// against the absolute minimum, then features can be added one at a time.
// Usage: node scripts/build-minimal-moc3.mjs <out.moc3>
import { writeFileSync } from 'node:fs';

const S = ['countInfo','canvas','parts.runtime0','parts.ids','parts.kbsi','parts.ksbi','parts.ksc','parts.visible','parts.enabled','parts.parentPart','deformers.runtime0','deformers.ids','deformers.kbsi','deformers.visible','deformers.enabled','deformers.parentPart','deformers.parentDeformer','deformers.types','deformers.specificSources','warp.kbsi','warp.ksbi','warp.ksc','warp.vertexCounts','warp.rows','warp.columns','rotation.kbsi','rotation.ksbi','rotation.ksc','rotation.baseAngles','am.runtime0','am.runtime1','am.runtime2','am.runtime3','am.ids','am.kbsi','am.ksbi','am.ksc','am.visible','am.enabled','am.parentPart','am.parentDeformer','am.textureNos','am.flags','am.vertexCounts','am.uvBegins','am.piBegins','am.piCounts','am.maskBegins','am.maskCounts','params.runtime0','params.ids','params.max','params.min','params.default','params.repeat','params.decimals','params.pbsbi','params.pbsc','partKf.drawOrders','warpKf.opacities','warpKf.kpBegins','rotKf.opacities','rotKf.angles','rotKf.originX','rotKf.originY','rotKf.scales','rotKf.reflectX','rotKf.reflectY','amKf.opacities','amKf.drawOrders','amKf.kpBegins','kfPos.xys','pbi.bindingSourcesIndices','kb.pbisbi','kb.pbisc','pb.keysBegins','pb.keysCounts','keys.values','uv.uvs','pi.indices','masks.artMeshSourcesIndices','groups.objBegins','groups.objCounts','groups.objTotalCounts','groups.maxDrawOrders','groups.minDrawOrders','groupObjects.types','groupObjects.indices','groupObjects.selfIndices','glue.runtime0','glue.ids','glue.kbsi','glue.ksbi','glue.ksc','glue.amA','glue.amB','glue.infoBegins','glue.infoCounts','glueInfo.weights','glueInfo.positionIndices','glueKf.intensities'];

// counts
const counts = { parts: 1, artMeshes: 1, parameters: 1, partKeyforms: 1, artMeshKeyforms: 1, keyformPositions: 16, keyformBindings: 1, drawOrderGroups: 1, drawOrderGroupObjects: 1 };

const align64 = (v) => Math.ceil(v / 64) * 64;
let cursor = 0x7c0;
const ptr = {};
const blocks = [];
const emit = (slot, data, followRuntime = false) => {
    if (!followRuntime) cursor = align64(cursor);
    ptr[S[slot]] = cursor;
    blocks.push([data, cursor]);
    cursor += data.length;
};

const s32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
const s32s = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeInt32LE(v, i * 4)); return b; };
const f32s = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const idBuf = (name) => { const b = Buffer.alloc(64); b.write(name); return b; };

// 0 countInfo: 23 counts padded to 128
{
    const b = Buffer.alloc(128);
    const order = ['parts','deformers','warp','rotation','artMeshes','parameters','partKeyforms','warpDeformerKeyforms','rotationDeformerKeyforms','artMeshKeyforms','keyformPositions','parameterBindingIndices','keyformBindings','parameterBindings','keys','uvs','positionIndices','drawableMasks','drawOrderGroups','drawOrderGroupObjects','glue','glueInfo','glueKeyforms'];
    order.forEach((name, i) => b.writeUInt32LE(counts[name] ?? 0, i * 4));
    emit(0, b);
}
// 1 canvas
emit(1, Buffer.concat([f32(100), f32(0.5), f32(0.5), f32(100), f32(100), Buffer.from([0])]));


// 2-9 parts (1)
emit(2, Buffer.alloc(8));
emit(3, idBuf('Part0'), true);
for (let s = 4; s <= 9; s++) emit(s, s32(s === 7 || s === 8 ? 1 : s === 9 ? -1 : 0));
// 10-18 deformers: none (counts 0) — pointers stay 0
// 19-24 warp: none
// 25-28 rotation: none
// 29-32 am runtime (8 bytes each, zeros)
for (let s = 29; s <= 32; s++) emit(s, Buffer.alloc(8));
// 33 am.ids
emit(33, idBuf('DMesh0'), true);
// 34-48 am arrays: kbsi, ksbi, ksc, visible, enabled, parentPart, parentDeformer, textureNos, flags(1B), vertexCounts, uvBegins, piBegins, piCounts, maskBegins, maskCounts
emit(34, s32(0));  // kbsi -> kb0 (empty)
emit(35, s32(0));  // ksbi
emit(36, s32(1));  // ksc = 1
emit(37, s32(1));  // visible
emit(38, s32(1));  // enabled
emit(39, s32(0));  // parentPart
emit(40, s32(-1)); // parentDeformer
emit(41, s32(0));  // textureNo
emit(42, Buffer.from([0])); // flags
emit(43, s32(4));  // vertexCount
emit(44, s32(0));  // uvBegin
emit(45, s32(0));  // piBegin
emit(46, s32(6));  // piCount
emit(47, s32(0));  // maskBegin
emit(48, s32(0));  // maskCount
// 49 params.runtime0 (8B)
emit(49, Buffer.alloc(8));
// 50 params.ids
emit(50, idBuf('ParamAngleX'), true);
// 51-57
emit(51, f32(30));   // max
emit(52, f32(-30));  // min
emit(53, f32(0));    // default
emit(54, f32(0));    // repeat
emit(55, s32(3));    // decimals
emit(56, s32(0));    // pbsbi
emit(57, s32(0));    // pbsc
// 58 partKf.drawOrders
emit(58, f32(0));
// 59-60 warpKf: none; 61-67 rotKf: none
// 68-70 amKf
emit(68, f32(1));   // opacity
emit(69, f32(0));   // drawOrder
emit(70, f32(0));   // kpBegin
// 71 kfPos (16 floats): neutral quad
emit(71, f32s([-0.1, -0.4, 0.1, -0.4, -0.1, -0.2, 0.1, -0.2, 0, 0, 0, 0, 0, 0, 0, 0]));
// 72 pbi: none
// 73-74 kb: 1 entry (empty)
emit(73, s32(0));
emit(74, s32(0));
// 75-77 pb/keys: none
// 78 uvs (4 verts)
emit(78, f32s([0, 0, 1, 0, 0, 1, 1, 1]));
// 79 pi (2 triangles)
{
    const b = Buffer.alloc(6 * 2);
    [0, 1, 2, 0, 2, 3].forEach((v, i) => b.writeUInt16LE(v, i * 2));
    emit(79, b);
}
// 80 masks: none
// 81-85 groups
emit(81, s32(0));          // objBegin
emit(82, s32(1));          // objCount
emit(83, s32(1));          // objTotal
emit(84, f32(0));          // maxDrawOrder
emit(85, f32(0));          // minDrawOrder
// 86-88 gObj
emit(86, s32(0));          // type artmesh
emit(87, s32(0));          // index
emit(88, s32(0));          // self
// 89-100 glue: none

const total = align64(cursor);
const out = Buffer.alloc(total);
out.write('MOC3', 0, 'latin1');
out[4] = 1; // version 1
for (const [slot, name] of S.entries()) {
    if (ptr[name] !== undefined) out.writeUInt32LE(ptr[name], 0x40 + slot * 4);
    else out.writeUInt32LE(total, 0x40 + slot * 4); // empty sections at EOF
}
for (const [data, at] of blocks) data.copy(out, at);
writeFileSync(process.argv[2], out);
console.log(`written ${process.argv[2]} (${out.length} bytes)`);
