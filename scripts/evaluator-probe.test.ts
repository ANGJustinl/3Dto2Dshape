// Dev tool (not a unit test): isolates the pose evaluator to see whether
// assignment values actually change the evaluated output.
// Run: npx vitest run scripts/evaluator-probe.test.ts
import { expect, it } from 'vitest';
import { createPoseEvaluator } from '../src/lib/live2d/keyforms';
import type { Live2dDrawable } from '../src/lib/live2d/model';

const drawable: Live2dDrawable = {
    label: 'quad',
    id: 'quad',
    meshId: 'mesh',
    leafIds: [],
    vertexCount: 4,
    triangleCount: 2,
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    meshVertexIndices: new Uint32Array([0, 1, 2, 3]),
    neutralPositions: new Float32Array([40, 60, 60, 60, 40, 80, 60, 80]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    texture: { width: 2, height: 2, rgba: new Uint8Array(16) },
    renderOrder: 0,
};

const mkFamily = (values: number[]) => ({
    family: 'ParamAngleX',
    default: 0,
    values,
    displacements: values.map((v) => new Float32Array([v, 0, v, 0, v, 0, v, 0])),
});

it('evaluator probe', () => {
    const families = { ParamAngleX: mkFamily([-30, 0, 30]) };
    const evaluator = createPoseEvaluator([drawable], [drawable.neutralPositions], families);
    const out = new Float32Array(8);

    evaluator.evaluate({ ParamAngleX: 30 } as never, [out]);
    console.log('evaluate X=30:', Array.from(out).map((v) => v.toFixed(1)).join(','));

    evaluator.evaluate({ ParamAngleX: -30 } as never, [out]);
    console.log('evaluate X=-30:', Array.from(out).map((v) => v.toFixed(1)).join(','));

    evaluator.evaluate({ ParamAngleX: 0 } as never, [out]);
    console.log('evaluate X=0:', Array.from(out).map((v) => v.toFixed(1)).join(','));

    evaluator.evaluate({} as never, [out]);
    console.log('evaluate empty:', Array.from(out).map((v) => v.toFixed(1)).join(','));

    expect(out.length).toBe(8);
});
