import { describe, expect, it } from 'vitest';
import { createPoseEvaluator, type JointKeyforms } from './keyforms';
import { defaultAssignment, FACE_PARAM_DEFINITIONS } from './paramMapping';
import { buildHeadJointKeyforms } from './headJoint';
import type { BakeBundle } from './types';
import { conservativeGeometryBounds, frameGeometryToViewport } from './framing';
import { resolveMouthMaskIds } from './mouthMasks';
import { splitHairLayers } from './hairLayers';
import type { DrawableDecomposition } from './decomposition';

const grid = (): JointKeyforms => ({
    x: { family: 'ParamAngleX', default: 0, values: [-30, 0, 30] },
    y: { family: 'ParamAngleY', default: 0, values: [-30, 0, 30] },
    displacements: Array.from({ length: 9 }, (_, i) => Float32Array.from(i === 8 ? [12, 8] : [0, 0])),
});

describe('joint head interpolation', () => {
    it('fits a bounded shared correction from observed corners without deforming the face or moving the body', () => {
        const face: DrawableDecomposition = {
            id: 'face', label: 'face', meshId: 'mesh', leafIds: [], vertexCount: 3, triangleCount: 1,
            triangles: Uint32Array.from([0,1,2]), meshVertexIndices: Uint32Array.from([0,1,2]),
        };
        const body = { ...face, id: 'body', label: 'body', meshVertexIndices: Uint32Array.from([3,4,5]) };
        const neutral = [Float32Array.from([0,0, 10,0, 5,10]), Float32Array.from([0,30, 10,30, 5,40])];
        const bundle: BakeBundle = {
            schemaVersion: 1, createdAt: '', modelName: 'fixture', parts: [],
            params: FACE_PARAM_DEFINITIONS.filter((p) => p.id === 'ParamAngleX' || p.id === 'ParamAngleY')
                .map((p) => ({ ...p, resolved: { meshId: 'mesh', boneName: 'head' } })),
            samples: [-30,30].flatMap((x) => [-30,30].map((y) => ({
                id: `${x}/${y}`, index: 0, kind: 'head-corner' as const,
                assignment: { ...defaultAssignment(), ParamAngleX: x, ParamAngleY: y },
                viewport: { width: 100, height: 100 },
                meshes: [{ meshId: 'mesh', vertices: {
                    screenX: Float32Array.from([100,110,105,0,10,5]),
                    screenY: Float32Array.from([0,0,10,30,30,40]), depth: new Float32Array(6),
                } }],
            }))),
        };
        const joint = buildHeadJointKeyforms(bundle, [face, body], neutral, {})[0];
        expect(joint).toBeDefined();
        const block = joint.displacements[8];
        expect(block[0]).toBeCloseTo(0.8); // 8% of the face height, despite a 100px raw residual.
        expect(block[2]).toBe(block[0]);
        expect(block[4]).toBe(block[0]);
        expect([...block.slice(6)]).toEqual([0,0,0,0,0,0]);
        expect([...joint.displacements[4]]).toEqual(new Array(12).fill(0));
    });
    it('preserves axial poses and interpolates the corner residual without swapping axes', () => {
        const output = [new Float32Array(2)];
        const evaluator = createPoseEvaluator([{ vertexCount: 1 }], [Float32Array.from([10, 20])], {}, [grid()]);
        const drive = (x: number, y: number) => {
            evaluator.evaluate({ ...defaultAssignment(), ParamAngleX: x, ParamAngleY: y }, output);
            return [...output[0]];
        };
        expect(drive(30, 0)).toEqual([10, 20]);
        expect(drive(0, 30)).toEqual([10, 20]);
        expect(drive(15, 30)).toEqual([16, 24]);
        expect(drive(15, 15)).toEqual([13, 22]);
        expect(drive(90, 90)).toEqual([22, 28]);
        expect(drive(-30, 30)).toEqual([10, 20]);
    });

    it('includes joint motion in framing and scales the exported residuals', () => {
        const neutral = [Float32Array.from([95, 95])];
        const joint = grid();
        expect(conservativeGeometryBounds(neutral, {}, [joint]).maxX).toBe(107);
        const framed = frameGeometryToViewport(neutral, {}, { width: 20, height: 20 }, 4, [joint]);
        const output = [new Float32Array(2)];
        createPoseEvaluator([{ vertexCount: 1 }], framed.neutralPositions, {}, framed.jointKeyforms)
            .evaluate({ ...defaultAssignment(), ParamAngleX: 30, ParamAngleY: 30 }, output);
        expect(output[0][0]).toBeLessThanOrEqual(16);
        expect(output[0][1]).toBeLessThanOrEqual(16);
    });
});

it('resolves mouth masks by actual ID within the same mesh', () => {
    const tooth = { id: 'tooth-2', label: '齿', meshId: 'a' };
    const unrelated = { id: 'wrong', label: '口线', meshId: 'b' };
    const lip = { id: 'actual-lip-42', label: '口线', meshId: 'a' };
    expect(resolveMouthMaskIds(tooth, [unrelated, lip, tooth])).toEqual([lip.id]);
    expect(resolveMouthMaskIds(tooth, [unrelated, tooth])).toBeUndefined();
});

it('splits disconnected hair islands while retaining every source triangle', () => {
    const triangles = [0,1,2, 0,2,3, 0,3,1, 1,3,2, 4,5,6, 4,6,7, 4,7,5, 5,7,6];
    const drawable: DrawableDecomposition = {
        id: 'hair', label: 'D髪', meshId: 'a', leafIds: ['original'], vertexCount: 8,
        triangleCount: 8, triangles: Uint32Array.from(triangles), meshVertexIndices: Uint32Array.from([10,11,12,13,14,15,16,17]),
    };
    const layers = splitHairLayers(drawable);
    expect(layers).toHaveLength(2);
    expect(layers.flatMap((d) => [...d.triangles].map((v) => d.meshVertexIndices[v])))
        .toEqual(triangles.map((v) => drawable.meshVertexIndices[v]));
    expect(splitHairLayers({ ...drawable, label: 'face' })).toHaveLength(1);
});
