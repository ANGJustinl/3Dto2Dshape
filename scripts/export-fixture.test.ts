// Dev tool (not a unit test): builds a two-axis fixture through the REAL
// writer, dumps writer-export.moc3 for the Core discovery script, and prints
// the writer's own slot assignment so the Core's reading can be compared.
// Run: npx vitest run scripts/export-fixture.test.ts
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { FamilyKeyforms } from '../src/lib/live2d/keyforms';
import { buildMoc3 } from '../src/lib/live2d/moc3';
import type { Live2dDrawable, Live2dModel } from '../src/lib/live2d/model';
import type { FaceParamId } from '../src/lib/live2d/types';

const PARAM_IDS: FaceParamId[] = [
    'ParamAngleX',
    'ParamAngleY',
    'ParamEyeLOpen',
    'ParamMouthOpenY',
];

const paramDefinition = (id: FaceParamId) => ({
    id,
    label: id,
    min: id.startsWith('ParamAngle') ? -30 : 0,
    max: id.startsWith('ParamAngle') ? 30 : 1,
    default: id === 'ParamEyeLOpen' ? 1 : 0,
});

const vertexCount = 4;
const drawables: Live2dDrawable[] = [
    {
        label: 'quad',
        id: 'quad',
        meshId: 'mesh',
        leafIds: [],
        vertexCount,
        triangleCount: 2,
        triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
        meshVertexIndices: new Uint32Array([0, 1, 2, 3]),
        neutralPositions: new Float32Array([40, 60, 60, 60, 40, 80, 60, 80]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        texture: { width: 2, height: 2, rgba: new Uint8Array(16) },
        renderOrder: 0,
    },
];

// Per-axis unique displacement: X family moves x by v; Y family moves y by v
// so the Core's output uniquely reveals which slot it read.
const family = (axis: 'X' | 'Y'): FamilyKeyforms => {
    const values = [-30, 0, 30];
    const displacements = values.map((v) => {
        const out = new Float32Array(vertexCount * 2);
        for (let i = 0; i < vertexCount; i += 1) {
            if (axis === 'X') out[i * 2] = v;
            else out[i * 2 + 1] = v;
        }
        return out;
    });
    return { family: `ParamAngle${axis}`, default: 0, values, displacements } satisfies FamilyKeyforms;
};

const model: Live2dModel = {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    modelName: 'axis-probe',
    viewport: { width: 100, height: 200 },
    params: PARAM_IDS.map(paramDefinition),
    drawables,
    families: { ParamAngleX: family('X'), ParamAngleY: family('Y') },
    depthFamilies: {},
    neutralDepths: [0],
    order: ['quad'],
    errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
    orderReport: { flips: [], samplesChecked: 0 },
};

it('exports the axis-probe fixture', () => {
    const result = buildMoc3(model);
    writeFileSync('tmp-render/writer-export.moc3', result.moc3);
    expect(result.moc3.length).toBeGreaterThan(0);
    console.log('writer-export.moc3 written,', result.moc3.length, 'bytes; keyformCounts', result.keyformCounts);
});
