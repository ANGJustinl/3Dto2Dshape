import { describe, expect, it } from 'vitest';
import { decomposeDrawables, drawableNeutralPositions } from './decomposition';
import { buildFamilyKeyforms, buildDepthKeyforms, createPoseEvaluator, createDepthEvaluator, evaluateComboError } from './keyforms';
import { computeDrawOrder, checkOrderConsistency, medianDepth } from './order';
import type { BakeBundle, ParamAssignment } from './types';

const assignment = (overrides: Partial<ParamAssignment> = {}): ParamAssignment => ({
    ParamAngleX: 0,
    ParamAngleY: 0,
    ParamAngleZ: 0,
    ParamEyeLOpen: 1,
    ParamEyeROpen: 1,
    ParamMouthOpenY: 0,
    ...overrides,
});

const meshSample = (screenX: number[], screenY: number[], depth: number[]) => ({
    meshId: 'mesh-1',
    vertices: {
        screenX: Float32Array.from(screenX),
        screenY: Float32Array.from(screenY),
        depth: Float32Array.from(depth),
    },
});

/**
 * Fixture: 8 mesh vertices. Face = verts 0-4 (two triangles sharing vert 2),
 * hair = verts 5-7. Yaw moves face +/-4px and hair +/-2px; blink adds +1px to
 * face only. The combo sample carries yaw 5 + blink 0 plus a 2px nonlinear
 * residual on the face, which is exactly what additive composition misses.
 */
const buildBundle = (): BakeBundle => ({
    schemaVersion: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
    modelName: 'test',
    params: [],
    parts: [
        { leafId: 'face-a', label: 'face', meshId: 'mesh-1', color: '#ff0000', triangleCount: 1, triangles: [[0, 1, 2]] },
        { leafId: 'face-b', label: 'face', meshId: 'mesh-1', color: '#ff0001', triangleCount: 1, triangles: [[2, 3, 4]] },
        { leafId: 'hair', label: 'hair', meshId: 'mesh-1', color: '#00ff00', triangleCount: 1, triangles: [[5, 6, 7]] },
    ],
    samples: [
        {
            id: 'neutral',
            kind: 'neutral',
            index: 0,
            assignment: assignment(),
            viewport: { width: 100, height: 100 },
            meshes: [
                meshSample(
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2],
                ),
            ],
        },
        {
            id: 'yaw-neg',
            kind: 'family-sweep',
            family: 'ParamAngleX',
            index: 1,
            assignment: assignment({ ParamAngleX: -10 }),
            viewport: { width: 100, height: 100 },
            meshes: [
                meshSample(
                    [-4, -3, -2, -1, 0, 8, 9, 10],
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2],
                ),
            ],
        },
        {
            id: 'yaw-pos',
            kind: 'family-sweep',
            family: 'ParamAngleX',
            index: 2,
            assignment: assignment({ ParamAngleX: 10 }),
            viewport: { width: 100, height: 100 },
            meshes: [
                meshSample(
                    [4, 5, 6, 7, 8, 12, 13, 14],
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2],
                ),
            ],
        },
        {
            id: 'blink',
            kind: 'family-sweep',
            family: 'ParamEyeLOpen',
            index: 3,
            assignment: assignment({ ParamEyeLOpen: 0 }),
            viewport: { width: 100, height: 100 },
            meshes: [
                meshSample(
                    [1, 2, 3, 4, 5, 10, 11, 12],
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2],
                ),
            ],
        },
        {
            id: 'combo-1',
            kind: 'combo-qa',
            index: 4,
            assignment: assignment({ ParamAngleX: 5, ParamEyeLOpen: 0 }),
            viewport: { width: 100, height: 100 },
            meshes: [
                meshSample(
                    [5, 6, 7, 8, 9, 11, 12, 13],
                    [0, 1, 2, 3, 4, 10, 11, 12],
                    [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2],
                ),
            ],
        },
    ],
});

describe('drawable decomposition', () => {
    it('merges leaves by material into compacted drawables', () => {
        const drawables = decomposeDrawables(buildBundle());
        expect(drawables).toHaveLength(2);

        const face = drawables.find((drawable) => drawable.label === 'face')!;
        expect(face.leafIds).toEqual(['face-a', 'face-b']);
        expect(face.triangleCount).toBe(2);
        expect(face.vertexCount).toBe(5);
        expect([...face.meshVertexIndices]).toEqual([0, 1, 2, 3, 4]);
        expect([...face.triangles]).toEqual([0, 1, 2, 2, 3, 4]);
    });

    it('neutral positions follow the compact vertex table', () => {
        const bundle = buildBundle();
        const drawables = decomposeDrawables(bundle);
        const neutral = bundle.samples[0];
        const hair = drawables.find((drawable) => drawable.label === 'hair')!;
        expect([...drawableNeutralPositions(hair, neutral)]).toEqual([10, 10, 11, 11, 12, 12]);
    });
});

describe('keyform interpolation', () => {
    const bundle = buildBundle();
    const drawables = decomposeDrawables(bundle);
    const neutral = bundle.samples[0];
    const families = buildFamilyKeyforms(bundle, drawables);
    const neutralPositions = drawables.map((drawable) => drawableNeutralPositions(drawable, neutral));
    const evaluator = createPoseEvaluator(drawables, neutralPositions, families);
    const outputs = drawables.map((drawable) => new Float32Array(drawable.vertexCount * 2));
    const faceIndex = drawables.findIndex((drawable) => drawable.label === 'face');
    const hairIndex = drawables.findIndex((drawable) => drawable.label === 'hair');

    it('at keyform values the pose matches the sample exactly', () => {
        evaluator.evaluate(assignment({ ParamAngleX: 10 }), outputs);
        expect(outputs[faceIndex][0]).toBeCloseTo(4);
        expect(outputs[hairIndex][0]).toBeCloseTo(12);
    });

    it('interpolates linearly between keyforms and adds across families', () => {
        evaluator.evaluate(assignment({ ParamAngleX: 5, ParamEyeLOpen: 0 }), outputs);
        // face: neutral 0 + yaw 4*0.5 + blink 1 = 3; hair: 10 + 2*0.5 = 11.
        expect(outputs[faceIndex][0]).toBeCloseTo(3);
        expect(outputs[hairIndex][0]).toBeCloseTo(11);
        expect(outputs[hairIndex][4]).toBeCloseTo(13);
    });

    it('clamps values outside the swept range', () => {
        evaluator.evaluate(assignment({ ParamAngleX: 999 }), outputs);
        expect(outputs[faceIndex][0]).toBeCloseTo(4);
    });

    it('reports additive-composition error against combo samples', () => {
        const report = evaluateComboError(bundle, drawables, evaluator);
        expect(report.comboCount).toBe(1);
        // Predicted face x at yaw5+blink: 3; true combo x: 5 -> 2px on 5 face
        // verts, 0 on hair -> mean 1.25 over 8 verts.
        expect(report.meanErrorPx).toBeCloseTo(1.25);
        expect(report.maxErrorPx).toBeCloseTo(2);
        expect(report.worstDrawable?.label).toBe('face');
    });
});

describe('draw order', () => {
    it('orders far-to-near by median neutral depth', () => {
        const bundle = buildBundle();
        const drawables = decomposeDrawables(bundle);
        const neutral = bundle.samples[0];
        const order = computeDrawOrder(drawables, neutral);
        expect(order).toHaveLength(2);
        expect(order[0]).toMatch(/hair/);
    });

    it('detects depth flips across samples', () => {
        const bundle = buildBundle();
        const drawables = decomposeDrawables(bundle);
        const neutral = bundle.samples[0];
        const order = computeDrawOrder(drawables, neutral);

        const stable = checkOrderConsistency(bundle, drawables, order);
        expect(stable.samplesChecked).toBe(4);
        expect(stable.flips).toHaveLength(0);

        const flipped = structuredClone(bundle);
        const combo = flipped.samples.find((s) => s.kind === 'combo-qa')!;
        const hairDrawable = drawables.find((d) => d.label === 'hair')!;
        hairDrawable.meshVertexIndices.forEach((meshIndex, v) => {
            combo.meshes[0].vertices.depth[meshIndex] = 0.05 + v * 0.001;
        });
        const flippedReport = checkOrderConsistency(flipped, drawables, order);
        expect(flippedReport.flips.length).toBeGreaterThanOrEqual(1);
        expect(flippedReport.flips[0].sampleId).toBe('combo-1');
    });
});

describe('dynamic depth ordering', () => {
    it('depth keyforms interpolate and re-rank drawables across a flip', () => {
        const bundle = buildBundle();
        // Let hair cross in front of the face at yaw +10: hair depth 0.05.
        const yawPos = bundle.samples.find((sample) => sample.id === 'yaw-pos')!;
        yawPos.meshes[0].vertices.depth.set([0.1, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05]);

        const drawables = decomposeDrawables(bundle);
        const neutral = bundle.samples[0];
        const faceIndex = drawables.findIndex((drawable) => drawable.label === 'face');
        const hairIndex = drawables.findIndex((drawable) => drawable.label === 'hair');

        // Neutral: hair (0.2) behind face (0.1).
        expect(medianDepth(drawables[faceIndex], neutral)).toBeCloseTo(0.1);
        expect(medianDepth(drawables[hairIndex], neutral)).toBeCloseTo(0.2);

        const depthFamilies = buildDepthKeyforms(bundle, drawables);
        const evaluator = createDepthEvaluator(
            drawables.length,
            drawables.map((drawable) => medianDepth(drawable, neutral)),
            depthFamilies,
        );
        const depths = new Float32Array(drawables.length);

        // At yaw +10 the hair (0.05) is NEARER than face (0.1): far-first
        // ranking puts hair LAST, i.e. drawn on top.
        evaluator.evaluate(assignment({ ParamAngleX: 10 }), depths);
        const ranked = [...drawables.keys()].sort((left, right) => depths[right] - depths[left]);
        expect(ranked[ranked.length - 1]).toBe(hairIndex);

        // Back at neutral the hair (0.2) is behind again: face on top.
        evaluator.evaluate(assignment({ ParamAngleX: 0 }), depths);
        const rankedNeutral = [...drawables.keys()].sort((left, right) => depths[right] - depths[left]);
        expect(rankedNeutral[rankedNeutral.length - 1]).toBe(faceIndex);

        // Halfway (yaw 5): interpolation stays in (0.05, 0.2) monotonically.
        evaluator.evaluate(assignment({ ParamAngleX: 5 }), depths);
        expect(depths[hairIndex]).toBeGreaterThan(0.05);
        expect(depths[hairIndex]).toBeLessThan(0.2);
    });
});
