import { buildMoc3 } from '../src/lib/live2d/moc3';
import type { FamilyKeyforms } from '../src/lib/live2d/keyforms';
import type { Live2dDrawable, Live2dModel } from '../src/lib/live2d/model';
import type { FaceParamId } from '../src/lib/live2d/types';
import { writeFileSync } from 'node:fs';

const PARAM_IDS: FaceParamId[] = ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamEyeLOpen','ParamEyeROpen','ParamMouthOpenY'];
const paramDefinition = (id: FaceParamId) => ({ id, label: id, min: id.startsWith('ParamAngle') ? -30 : 0, max: id.startsWith('ParamAngle') ? 30 : 1, default: id.startsWith('ParamEye') ? 1 : 0 });
const drawable = (o: Partial<Live2dDrawable> & Pick<Live2dDrawable, 'id'>): Live2dDrawable => ({ label: o.id, meshId: 'mesh', leafIds: [], vertexCount: 3, triangleCount: 1, triangles: new Uint32Array([0,1,2]), meshVertexIndices: new Uint32Array([0,1,2]), neutralPositions: new Float32Array([10,20,30,20,20,40]), uvs: new Float32Array([0,0,1,0,0,1]), texture: { width: 2, height: 2, rgba: new Uint8Array(16) }, renderOrder: 0, ...o });
const packed = (headDx: number) => new Float32Array([0,0,0,0,0,0, headDx,0,headDx,0,headDx,0,headDx,0]);
const sweep = (steps: number) => Array.from({ length: steps }, (_, i) => i / (steps - 1));
const model: Live2dModel = {
    schemaVersion: 1, createdAt: 'x', modelName: 'fixture', viewport: { width: 100, height: 200 },
    params: PARAM_IDS.map(paramDefinition),
    drawables: [
        drawable({ id: 'body', renderOrder: 0 }),
        drawable({ id: 'head', vertexCount: 4, triangleCount: 2, triangles: new Uint32Array([0,1,2,0,2,3]), meshVertexIndices: new Uint32Array([0,1,2,3]), neutralPositions: new Float32Array([40,60,60,60,40,80,60,80]), uvs: new Float32Array([0,0,1,0,0,1,1,1]), renderOrder: 1 }),
    ],
    families: {
        ParamAngleX: { family: 'ParamAngleX', default: 0, values: [-30, 30], displacements: [packed(-6), packed(6)] } satisfies FamilyKeyforms,
        ParamEyeLOpen: { family: 'ParamEyeLOpen', default: 1, values: sweep(9), displacements: sweep(9).map(() => packed(3)) } satisfies FamilyKeyforms,
    },
    depthFamilies: {}, neutralDepths: [0, 0], order: ['body', 'head'],
    errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
    orderReport: { flips: [], samplesChecked: 0 },
};
writeFileSync(process.argv[2], buildMoc3(model).moc3);
console.log('written', process.argv[2]);
