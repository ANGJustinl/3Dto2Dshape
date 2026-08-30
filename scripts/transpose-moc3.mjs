// Dev tool: transposes a moc3's keyform tensor per artmesh from row-major
// over the (ascending) pbi axis order — what the pre-fix writer emitted —
// to column-major (lowest param index fastest), which is the lookup the
// Cubism Core performs (verified on a labelled fixture + VTS samples).
// Everything else is copied byte-for-byte.
// Usage: node scripts/transpose-moc3.mjs <in.moc3> <out.moc3>
import { readFileSync, writeFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (o) => view.getUint32(o, true);
const s32 = (o) => view.getInt32(o, true);

const SLOTS = ['countInfo','canvas','parts.runtime0','parts.ids','parts.kbsi','parts.ksbi','parts.ksc','parts.visible','parts.enabled','parts.parentPart','deformers.runtime0','deformers.ids','deformers.kbsi','deformers.visible','deformers.enabled','deformers.parentPart','deformers.parentDeformer','deformers.types','deformers.specificSources','warp.kbsi','warp.ksbi','warp.ksc','warp.vertexCounts','warp.rows','warp.columns','rotation.kbsi','rotation.ksbi','rotation.ksc','rotation.baseAngles','am.runtime0','am.runtime1','am.runtime2','am.runtime3','am.ids','am.kbsi','am.ksbi','am.ksc','am.visible','am.enabled','am.parentPart','am.parentDeformer','am.textureNos','am.flags','am.vertexCounts','am.uvBegins','am.piBegins','am.piCounts','am.maskBegins','am.maskCounts','params.runtime0','params.ids','params.max','params.min','params.default','params.repeat','params.decimals','params.pbsbi','params.pbsc','partKf.drawOrders','warpKf.opacities','warpKf.kpBegins','rotKf.opacities','rotKf.angles','rotKf.originX','rotKf.originY','rotKf.scales','rotKf.reflectX','rotKf.reflectY','amKf.opacities','amKf.drawOrders','amKf.kpBegins','kfPos.xys','pbi.bindingSourcesIndices','kb.pbisbi','kb.pbisc','pb.keysBegins','pb.keysCounts','keys.values','uv.uvs','pi.indices','masks.artMeshSourcesIndices','groups.objBegins','groups.objCounts','groups.objTotalCounts','groups.maxDrawOrders','groups.minDrawOrders','groupObjects.types','groupObjects.indices','groupObjects.selfIndices','glue.runtime0','glue.ids','glue.kbsi','glue.ksbi','glue.ksc','glue.amA','glue.amB','glue.infoBegins','glue.infoCounts','glueInfo.weights','glueInfo.positionIndices','glueKf.intensities'];
const T = (name) => u32(0x40 + SLOTS.indexOf(name) * 4);
const c = {};
['parts','deformers','warp','rotation','artMeshes','parameters','partKeyforms','warpDeformerKeyforms','rotationDeformerKeyforms','artMeshKeyforms','keyformPositions','parameterBindingIndices','keyformBindings','parameterBindings','keys'].forEach((n, i) => { c[n] = u32(T('countInfo') + i * 4); });

const ia = (name, count) => Array.from({ length: count }, (_, i) => s32(T(name) + i * 4));
const amVc = ia('am.vertexCounts', c.artMeshes);
const amKbsi = ia('am.kbsi', c.artMeshes);
const amKsbi = ia('am.ksbi', c.artMeshes);
const amKsc = ia('am.ksc', c.artMeshes);
const kbB = ia('kb.pbisbi', c.keyformBindings);
const kbC = ia('kb.pbisc', c.keyformBindings);
const pbi = ia('pbi.bindingSourcesIndices', c.parameterBindingIndices);
const pbKeysCounts = ia('pb.keysCounts', c.parameterBindings);
const kpBegins = Array.from({ length: c.artMeshKeyforms }, (_, i) => s32(T('amKf.kpBegins') + i * 4));

const kfBase = T('kfPos.xys');
const poolFloats = c.keyformPositions;
const oldPool = bytes.subarray(kfBase, kfBase + poolFloats * 4);
const newPool = Buffer.from(oldPool); // copy

const strideOf = (mesh) => Math.ceil((amVc[mesh] * 2) / 16) * 16;

for (let mesh = 0; mesh < c.artMeshes; mesh += 1) {
    const ksc = amKsc[mesh];
    if (ksc <= 1) continue;
    const kbi = amKbsi[mesh];
    const axes = pbi.slice(kbB[kbi], kbB[kbi] + kbC[kbi]);
    const radices = axes.map((pi) => pbKeysCounts[pi]);
    const product = radices.reduce((a, b) => a * b, 1);
    if (product !== ksc) {
        throw new Error(`mesh ${mesh}: ksc ${ksc} != product ${product} of axes [${axes}]`);
    }
    const stride = strideOf(mesh);
    const base = amKsbi[mesh];
    // sanity: kpBegins contiguous
    for (let k = 1; k < ksc; k += 1) {
        if (kpBegins[base + k] - kpBegins[base + k - 1] !== stride) {
            throw new Error(`mesh ${mesh}: non-contiguous kpBegins`);
        }
    }
    const meshStart = kpBegins[base];
    const readSlot = (k) =>
        oldPool.subarray((meshStart + k * stride) * 4, (meshStart + (k + 1) * stride) * 4);
    const slots = Array.from({ length: ksc }, (_, k) => readSlot(k));
    for (let col = 0; col < ksc; col += 1) {
        // digits of `col` under the NEW column-major layout (axis0 fastest)
        const digits = [];
        let rest = col;
        for (let a = 0; a < axes.length; a += 1) {
            digits[a] = rest % radices[a];
            rest = Math.floor(rest / radices[a]);
        }
        // the OLD row-major slot that holds the same digit vector
        let row = 0;
        for (let a = 0; a < axes.length; a += 1) {
            let prod = 1;
            for (let j = a + 1; j < axes.length; j += 1) prod *= radices[j];
            row += digits[a] * prod;
        }
        slots[row].copy(newPool, (meshStart + col * stride) * 4);
    }
    console.log(`mesh ${mesh}: axes=[${axes}] radices=[${radices}] transposed ${ksc} slots (stride ${stride})`);
}

const out = Buffer.from(bytes);
newPool.copy(out, kfBase);
writeFileSync(process.argv[3], out);
console.log(`written ${process.argv[3]} (${out.length} bytes)`);
