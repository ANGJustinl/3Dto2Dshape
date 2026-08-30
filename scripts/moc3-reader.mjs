// Shared semantic reader for version-1 .moc3 files written by our exporter.
// Usage: import { readMoc3 } from './moc3-reader.mjs'
import { readFileSync } from 'node:fs';

export const SLOTS = [
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

export const readMoc3 = (path) => {
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The exported file under review has a truncated tail (its declared
    // positionIndices run 51 entries past EOF), so out-of-bounds reads clamp.
    const u32 = (o) => (o + 4 <= view.byteLength ? view.getUint32(o, true) : 0);
    const s32 = (o) => (o + 4 <= view.byteLength ? view.getInt32(o, true) : 0);
    const f32 = (o) => (o + 4 <= view.byteLength ? view.getFloat32(o, true) : NaN);
    const s16 = (o) => (o + 2 <= view.byteLength ? view.getInt16(o, true) : 0);
    const id = (o) => {
        const raw = bytes.subarray(o, o + 64);
        let end = raw.indexOf(0);
        if (end < 0) end = 64;
        return new TextDecoder().decode(raw.subarray(0, end));
    };
    const slot = (name) => u32(0x40 + SLOTS.indexOf(name) * 4);

    const c = {};
    ['parts', 'deformers', 'warp', 'rotation', 'artMeshes', 'parameters', 'partKeyforms',
        'warpDeformerKeyforms', 'rotationDeformerKeyforms', 'artMeshKeyforms', 'keyformPositions',
        'parameterBindingIndices', 'keyformBindings', 'parameterBindings', 'keys', 'uvs',
        'positionIndices', 'drawableMasks', 'drawOrderGroups', 'drawOrderGroupObjects',
        'glue', 'glueInfo', 'glueKeyforms'].forEach((name, index) => {
        c[name] = u32(slot('countInfo') + index * 4);
    });

    const s32Arr = (name, count) => Array.from({ length: count }, (_, i) => s32(slot(name) + i * 4));
    const u32Arr = (name, count) => Array.from({ length: count }, (_, i) => u32(slot(name) + i * 4));
    const f32Arr = (name, count) => Array.from({ length: count }, (_, i) => f32(slot(name) + i * 4));
    const idArr = (name, count) => Array.from({ length: count }, (_, i) => id(slot(name) + i * 64));

    const params = {
        ids: idArr('params.ids', c.parameters),
        min: f32Arr('params.min', c.parameters),
        max: f32Arr('params.max', c.parameters),
        def: f32Arr('params.default', c.parameters),
        repeat: s32Arr('params.repeat', c.parameters),
        decimals: s32Arr('params.decimals', c.parameters),
        pbsbi: s32Arr('params.pbsbi', c.parameters),
        pbsc: s32Arr('params.pbsc', c.parameters),
    };
    const pbOwner = new Array(c.parameterBindings).fill(-1);
    for (let p = 0; p < c.parameters; p += 1) {
        for (let k = 0; k < params.pbsc[p]; k += 1) {
            params.pbsbi[p] >= 0 && (pbOwner[params.pbsbi[p] + k] = p);
        }
    }

    const am = {
        ids: idArr('am.ids', c.artMeshes),
        kbsi: s32Arr('am.kbsi', c.artMeshes),
        ksbi: s32Arr('am.ksbi', c.artMeshes),
        ksc: s32Arr('am.ksc', c.artMeshes),
        visible: u32Arr('am.visible', c.artMeshes),
        enabled: u32Arr('am.enabled', c.artMeshes),
        parentPart: s32Arr('am.parentPart', c.artMeshes),
        parentDeformer: s32Arr('am.parentDeformer', c.artMeshes),
        textureNos: u32Arr('am.textureNos', c.artMeshes),
        vertexCounts: s32Arr('am.vertexCounts', c.artMeshes),
        uvBegins: s32Arr('am.uvBegins', c.artMeshes),
        piBegins: s32Arr('am.piBegins', c.artMeshes),
        piCounts: s32Arr('am.piCounts', c.artMeshes),
    };

    // Per-artmesh binding structure: pbs (pool order) -> owning param + key values.
    const pbi = s32Arr('pbi.bindingSourcesIndices', c.parameterBindingIndices);
    const kbBegins = s32Arr('kb.pbisbi', c.keyformBindings);
    const kbCounts = s32Arr('kb.pbisc', c.keyformBindings);
    const pbKeysBegins = s32Arr('pb.keysBegins', c.parameterBindings);
    const pbKeysCounts = s32Arr('pb.keysCounts', c.parameterBindings);
    const keys = f32Arr('keys.values', c.keys);

    const bindings = am.kbsi.map((kb) => {
        if (kb === 0) return [];
        const pbs = pbi.slice(kbBegins[kb], kbBegins[kb] + kbCounts[kb]);
        return pbs.map((pb) => {
            const owner = pbOwner[pb];
            const values = keys.slice(pbKeysBegins[pb], pbKeysBegins[pb] + pbKeysCounts[pb]);
            let neutralIndex = 0;
            values.forEach((v, i) => {
                if (Math.abs(v - params.def[owner]) < Math.abs(values[neutralIndex] - params.def[owner])) {
                    neutralIndex = i;
                }
            });
            return { pb, paramIndex: owner, paramId: params.ids[owner], values, neutralIndex };
        });
    });

    const neutralSlot = (amIndex) => {
        let slotIndex = 0;
        bindings[amIndex].forEach((binding) => {
            slotIndex = slotIndex * binding.values.length + binding.neutralIndex;
        });
        return slotIndex;
    };

    const kfPosBase = (amIndex) => {
        const slotIndex = am.ksbi[amIndex] + neutralSlot(amIndex);
        return s32(slot('amKf.kpBegins') + slotIndex * 4);
    };

    // Neutral vertex positions in FILE units (y down, centered) and file uvs.
    // amKf.kpBegins are FLOAT offsets into the kfPos pool (verified against
    // the sample models: consecutive slots stride by 2*vertexCount).
    const neutralPositions = am.vertexCounts.map((n, i) => {
        const base = kfPosBase(i);
        const out = new Float32Array(n * 2);
        for (let v = 0; v < n; v += 1) {
            out[v * 2] = f32(slot('kfPos.xys') + (base + v * 2) * 4);
            out[v * 2 + 1] = f32(slot('kfPos.xys') + (base + v * 2 + 1) * 4);
        }
        return out;
    });
    const uvs = am.vertexCounts.map((n, i) => {
        const out = new Float32Array(n * 2);
        for (let v = 0; v < n; v += 1) {
            out[v * 2] = f32(slot('uv.uvs') + (am.uvBegins[i] + v * 2) * 4);
            out[v * 2 + 1] = f32(slot('uv.uvs') + (am.uvBegins[i] + v * 2 + 1) * 4);
        }
        return out;
    });
    const indices = am.piCounts.map((count, i) => {
        const out = new Int16Array(count);
        for (let t = 0; t < count; t += 1) {
            out[t] = s16(slot('pi.indices') + (am.piBegins[i] + t) * 2);
        }
        return out;
    });

    const canvasSlot = slot('canvas');
    const canvas = {
        ppu: f32(canvasSlot),
        originX: f32(canvasSlot + 4),
        originY: f32(canvasSlot + 8),
        width: f32(canvasSlot + 12),
        height: f32(canvasSlot + 16),
    };

    return {
        bytes, view, slot, c, params, pbOwner, am, bindings, pbi, kbBegins, kbCounts,
        pbKeysBegins, pbKeysCounts, keys, neutralSlot, kfPosBase, neutralPositions, uvs, indices, canvas,
    };
};
