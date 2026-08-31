// Minimal fixtures for native-consistency bisection.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { buildMoc3 } from '../src/lib/live2d/moc3';
import type { Live2dDrawable, Live2dModel } from '../src/lib/live2d/model';
import type { FaceParamId } from '../src/lib/live2d/types';

const paramIds: FaceParamId[] = ['ParamAngleX', 'ParamAngleY', 'ParamEyeLOpen', 'ParamMouthOpenY'];
const drawable = (id: string, y: number): Live2dDrawable => ({
    label: id,
    id,
    meshId: 'mesh',
    leafIds: [],
    vertexCount: 4,
    triangleCount: 2,
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    meshVertexIndices: new Uint32Array([0, 1, 2, 3]),
    neutralPositions: new Float32Array([40, y, 60, y, 40, y + 20, 60, y + 20]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    texture: { width: 2, height: 2, rgba: new Uint8Array(16).fill(200) },
    renderOrder: 0,
});
const baseModel = (): Live2dModel => ({
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    modelName: 'probe',
    viewport: { width: 100, height: 200 },
    params: paramIds.map((id) => ({
        id,
        label: id,
        min: id.startsWith('ParamAngle') ? -30 : 0,
        max: id.startsWith('ParamAngle') ? 30 : 1,
        default: id === 'ParamEyeLOpen' ? 1 : 0,
    })),
    drawables: [],
    families: {},
    depthFamilies: {},
    neutralDepths: [],
    order: [],
    errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
    orderReport: { flips: [], samplesChecked: 0 },
});

it('writes probe fixtures', () => {
    // a: two static drawables, no masks
    const a = baseModel();
    a.drawables = [drawable('D唇线', 60), drawable('D齿', 62)];
    a.neutralDepths = [0, 0];
    a.order = ['D唇线', 'D齿'];
    writeFileSync('tmp-render/probe-a.moc3', buildMoc3(a).moc3);
    // b: same + mask declaration
    const b = baseModel();
    b.drawables = [drawable('D唇线', 60), { ...drawable('D齿', 62), maskIds: ['D唇线'], renderOrder: 1 }];
    b.neutralDepths = [0, 0];
    b.order = ['D唇线', 'D齿'];
    writeFileSync('tmp-render/probe-b.moc3', buildMoc3(b).moc3);
});
