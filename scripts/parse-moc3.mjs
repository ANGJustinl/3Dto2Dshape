// Dev tool: semantic parser for version-1 .moc3 files (the layout VTube
// Studio's bundled models use). Validates the flattened per-member pointer
// table at 0x40 against cross-consistency sums. Usage:
//   node scripts/parse-moc3.mjs <file.moc3>
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (o) => view.getUint32(o, true);
const s32 = (o) => view.getInt32(o, true);
const f32 = (o) => view.getFloat32(o, true);
const s16 = (o) => view.getInt16(o, true);
const id = (o) => {
    const raw = bytes.subarray(o, o + 64);
    let end = raw.indexOf(0);
    if (end < 0) {
        end = 64;
    }
    return new TextDecoder().decode(raw.subarray(0, end));
};

if (bytes.subarray(0, 4).toString('latin1') !== 'MOC3') {
    throw new Error('not a moc3');
}
const version = bytes[4];
console.log(`version byte: ${version}, size: ${bytes.length}`);

// Flattened slot map (V3_00_00 declaration order from moc3.hexpat).
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
const isEmpty = (name) => slot(name) === bytes.length || slot(name) === 0;

const c = {};
[
    'parts', 'deformers', 'warp', 'rotation', 'artMeshes', 'parameters', 'partKeyforms',
    'warpDeformerKeyforms', 'rotationDeformerKeyforms', 'artMeshKeyforms', 'keyformPositions',
    'parameterBindingIndices', 'keyformBindings', 'parameterBindings', 'keys', 'uvs',
    'positionIndices', 'drawableMasks', 'drawOrderGroups', 'drawOrderGroupObjects',
    'glue', 'glueInfo', 'glueKeyforms',
].forEach((name, index) => {
    c[name] = u32(target('countInfo') + index * 4);
});
console.log('counts:', c);

const readS32Array = (name, count) => Array.from({ length: count }, (_, i) => s32(target(name) + i * 4));
const readF32Array = (name, count) => Array.from({ length: count }, (_, i) => f32(target(name) + i * 4));
const readIds = (name, count) => Array.from({ length: count }, (_, i) => id(target(name) + i * 64));

console.log('\n== slots in use ==');
SLOTS.forEach((name, index) => {
    if (target(name) !== 0) {
        console.log(`  [${index}] ${name} -> 0x${target(name).toString(16)}${target(name) === bytes.length ? ' (EOF)' : ''}`);
    }
});

console.log('\n== parts ==');
const partIds = readIds('parts.ids', c.parts);
console.log('ids:', partIds.slice(0, 6));
console.log('kbsi:', readS32Array('parts.kbsi', c.parts).slice(0, 8));
console.log('ksbi:', readS32Array('parts.ksbi', c.parts).slice(0, 8));
console.log('ksc:', readS32Array('parts.ksc', c.parts).slice(0, 8));
console.log('parentPart:', readS32Array('parts.parentPart', c.parts).slice(0, 8));

console.log('\n== art meshes ==');
const amIds = readIds('am.ids', c.artMeshes);
console.log('ids:', amIds.slice(0, 6));
const amVc = readS32Array('am.vertexCounts', c.artMeshes);
const amPiCounts = readS32Array('am.piCounts', c.artMeshes);
const amKsbi = readS32Array('am.ksbi', c.artMeshes);
const amKsc = readS32Array('am.ksc', c.artMeshes);
const amKbsi = readS32Array('am.kbsi', c.artMeshes);
const amUvBegins = readS32Array('am.uvBegins', c.artMeshes);
const amPiBegins = readS32Array('am.piBegins', c.artMeshes);
const amKpBegins = readS32Array('amKf.kpBegins', c.artMeshKeyforms);
console.log('vertexCounts[:6]:', amVc.slice(0, 6), 'sum:', amVc.reduce((a, b) => a + b, 0));
console.log('uvs count:', c.uvs, '=> elements if /2:', c.uvs / 2, '| last uvBegin:', amUvBegins[c.artMeshes - 1]);
console.log('piCounts sum:', amPiCounts.reduce((a, b) => a + b, 0), 'vs positionIndices count:', c.positionIndices);
console.log('ksbi[:6]:', amKsbi.slice(0, 6), 'ksc[:6]:', amKsc.slice(0, 6), 'ksc sum:', amKsc.reduce((a, b) => a + b, 0), 'vs amKf:', c.artMeshKeyforms);
console.log('kbsi[:10]:', amKbsi.slice(0, 10), 'min:', Math.min(...amKbsi), 'max:', Math.max(...amKbsi), 'vs kb count:', c.keyformBindings);
console.log('textureNos unique:', [...new Set(readS32Array('am.textureNos', c.artMeshes))]);
console.log('flags unique:', [...new Set(readS32Array('am.flags', c.artMeshes))].map((v) => '0b' + (v >>> 0).toString(2)));
console.log('maskBegins unique:', [...new Set(readS32Array('am.maskBegins', c.artMeshes))], 'maskCounts unique:', [...new Set(readS32Array('am.maskCounts', c.artMeshes))]);
console.log('kpBegins last:', amKpBegins[c.artMeshKeyforms - 1], 'vs keyformPositions:', c.keyformPositions, '(xys?', c.keyformPositions / 2, ')');

console.log('\n== parameters ==');
const paramIds = readIds('params.ids', c.parameters);
console.log('ids[:10]:', paramIds.slice(0, 10));
const pbsbi = readS32Array('params.pbsbi', c.parameters);
const pbsc = readS32Array('params.pbsc', c.parameters);
const angleX = paramIds.indexOf('ParamAngleX');
console.log('AngleX idx:', angleX, 'pbsbi/c:', pbsbi[angleX], pbsc[angleX]);
console.log('pbsc sum:', pbsc.reduce((a, b) => a + b, 0), 'vs pbi count:', c.parameterBindingIndices);

console.log('\n== bindings ==');
const kbBegins = readS32Array('kb.pbisbi', c.keyformBindings);
const kbCounts = readS32Array('kb.pbisc', c.keyformBindings);
console.log('kb begins[:8]:', kbBegins.slice(0, 8), 'counts[:8]:', kbCounts.slice(0, 8));
console.log('kb counts sum:', kbCounts.reduce((a, b) => a + b, 0), 'vs pbi:', c.parameterBindingIndices);
const pbi = readS32Array('pbi.bindingSourcesIndices', c.parameterBindingIndices);
console.log('pbi values[:16]:', pbi.slice(0, 16), 'min:', Math.min(...pbi), 'max:', Math.max(...pbi), 'vs pb count:', c.parameterBindings);
const pbKeysBegins = readS32Array('pb.keysBegins', c.parameterBindings);
const pbKeysCounts = readS32Array('pb.keysCounts', c.parameterBindings);
console.log('pb keysBegins[:8]:', pbKeysBegins.slice(0, 8), 'keysCounts[:8]:', pbKeysCounts.slice(0, 8));
console.log('pb keysCounts max end:', Math.max(...pbKeysBegins.map((b, i) => b + pbKeysCounts[i])), 'vs keys count:', c.keys);
const angleXBindings = pbi.slice(pbsbi[angleX], pbsbi[angleX] + pbsc[angleX]);
const firstBinding = angleXBindings[0];
console.log('AngleX pbi slice[:6]:', angleXBindings.slice(0, 6));
console.log('AngleX first binding keys:', pbKeysCounts[firstBinding], readF32Array('keys.values', pbKeysCounts[firstBinding]).map(() => ''),
    Array.from({ length: pbKeysCounts[firstBinding] }, (_, i) => f32(target('keys.values') + (pbKeysBegins[firstBinding] + i) * 4)));

console.log('\n== artmesh keyforms ==');
console.log('opacities unique:', [...new Set(readF32Array('amKf.opacities', c.artMeshKeyforms))].slice(0, 4));
console.log('drawOrders[:8]:', readF32Array('amKf.drawOrders', c.artMeshKeyforms).slice(0, 8));

console.log('\n== canvas ==');
const canvas = target('canvas');
console.log('ppu:', f32(canvas), 'origin:', f32(canvas + 4), f32(canvas + 8), 'size:', f32(canvas + 12), f32(canvas + 16), 'flags:', bytes[canvas + 20]);
