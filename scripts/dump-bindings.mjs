// Dev tool: dump the parameter-binding graph shape of a .moc3.
// Answers: how many DISTINCT parameters each keyform binding (kb) jointly
// references — the "tensor order" of every keyform list.
// Usage: node scripts/dump-bindings.mjs <file.moc3> [more.moc3 ...]
import { readFileSync } from 'node:fs';

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

for (const path of process.argv.slice(2)) {
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (o) => view.getUint32(o, true);
    const s32 = (o) => view.getInt32(o, true);
    const f32 = (o) => view.getFloat32(o, true);
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

    const paramIds = Array.from({ length: c.parameters }, (_, i) => id(slot('params.ids') + i * 64));
    const pbsbi = Array.from({ length: c.parameters }, (_, i) => s32(slot('params.pbsbi') + i * 4));
    const pbsc = Array.from({ length: c.parameters }, (_, i) => s32(slot('params.pbsc') + i * 4));

    // pb index -> owning param index
    const pbOwner = new Array(c.parameterBindings).fill(-1);
    let overlap = false;
    for (let p = 0; p < c.parameters; p += 1) {
        for (let k = 0; k < pbsc[p]; k += 1) {
            if (pbOwner[pbsbi[p] + k] !== -1) overlap = true;
            pbOwner[pbsbi[p] + k] = p;
        }
    }

    const pbi = Array.from({ length: c.parameterBindingIndices }, (_, i) => s32(slot('pbi.bindingSourcesIndices') + i * 4));
    const kbBegins = Array.from({ length: c.keyformBindings }, (_, i) => s32(slot('kb.pbisbi') + i * 4));
    const kbCounts = Array.from({ length: c.keyformBindings }, (_, i) => s32(slot('kb.pbisc') + i * 4));

    const amIds = Array.from({ length: c.artMeshes }, (_, i) => id(slot('am.ids') + i * 64));
    const amKbsi = Array.from({ length: c.artMeshes }, (_, i) => s32(slot('am.kbsi') + i * 4));

    // distinct-param order per kb
    const orderHist = new Map();
    const examples = new Map();
    for (let kb = 0; kb < c.keyformBindings; kb += 1) {
        const pbs = pbi.slice(kbBegins[kb], kbBegins[kb] + kbCounts[kb]);
        const params = new Set(pbs.map((pb) => pbOwner[pb]).filter((v) => v >= 0));
        const order = params.size;
        orderHist.set(order, (orderHist.get(order) ?? 0) + 1);
        if (!examples.has(order)) {
            examples.set(order, { kb, pbs, paramNames: [...params].map((p) => paramIds[p]) });
        }
    }

    // per-artmesh tensor order (max over its kb range — artmesh kbs are contiguous in kb array)
    const amOrder = amKbsi.map((begin, am) => {
        // infer count: next artmesh's begin, or kb total
        let end = c.keyformBindings;
        for (let j = am + 1; j < c.artMeshes; j += 1) {
            if (amKbsi[j] > begin) { end = amKbsi[j]; break; }
        }
        let maxOrder = 0;
        for (let kb = begin; kb < end; kb += 1) {
            const pbs = pbi.slice(kbBegins[kb], kbBegins[kb] + kbCounts[kb]);
            const params = new Set(pbs.map((pb) => pbOwner[pb]).filter((v) => v >= 0));
            if (params.size > maxOrder) maxOrder = params.size;
        }
        return maxOrder;
    });

    console.log(`\n=== ${path.split(/[\\/]/).pop()} (ver ${bytes[4]}) ===`);
    console.log('params:', c.parameters, paramIds.filter((v) => v.startsWith('Param')).slice(0, 8).join(','));
    console.log('pb owner overlap:', overlap, '| unowned pbs:', pbOwner.filter((v) => v === -1).length);
    console.log('kb tensor-order histogram (distinct params per keyform binding):',
        [...orderHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}p:${v}`).join('  '));
    console.log('order examples:', [...examples.entries()].sort((a, b) => a[0] - b[0])
        .map(([order, ex]) => `order${order}->kb${ex.kb} pbs[${ex.pbs}] params[${ex.paramNames.join('|')}]`).join('   '));
    const badAm = amIds.map((id2, i) => ({ id: id2, order: amOrder[i] })).filter((v) => v.order >= 3);
    console.log('artmeshes with >=3-param tensors:', badAm.length ? badAm.map((v) => `${v.id}(${v.order}p)`).slice(0, 12).join(', ') : 'NONE');

    // keyform-count sanity: artmesh keyform count vs product of keys per kb
    const amKsc = Array.from({ length: c.artMeshes }, (_, i) => s32(slot('am.ksc') + i * 4));
    const amKsbi = Array.from({ length: c.artMeshes }, (_, i) => s32(slot('am.ksbi') + i * 4));
    const pbKeysBegins = Array.from({ length: c.parameterBindings }, (_, i) => s32(slot('pb.keysBegins') + i * 4));
    const pbKeysCounts = Array.from({ length: c.parameterBindings }, (_, i) => s32(slot('pb.keysCounts') + i * 4));
    // check first 5 bound artmeshes: does ksc == product of key counts of its kb's pbs?
    const checks = [];
    for (let am = 0; am < c.artMeshes && checks.length < 5; am += 1) {
        const kfCount = amKsc[am];
        if (kfCount <= 1) continue;
        const begin = amKbsi[am];
        let end = c.keyformBindings;
        for (let j = am + 1; j < c.artMeshes; j += 1) {
            if (amKbsi[j] > begin) { end = amKbsi[j]; break; }
        }
        let product = 1;
        const keyLists = [];
        for (let kb = begin; kb < end; kb += 1) {
            const pbs = pbi.slice(kbBegins[kb], kbBegins[kb] + kbCounts[kb]);
            for (const pb of pbs) {
                const kc = pbKeysCounts[pb];
                product *= kc;
                keyLists.push(`${paramIds[pbOwner[pb]]}:${kc}`);
            }
        }
        checks.push(`${amIds[am]} ksc=${kfCount} product=${product} [${keyLists.join(' x ')}]${kfCount === product ? ' OK' : ' **MISMATCH**'}`);
    }
    console.log('ksc-vs-product checks:');
    checks.forEach((line) => console.log('  ', line));
}
