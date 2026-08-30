import { describe, expect, it } from 'vitest';
import { familyDigest, summarizeBake } from './bakeSummary';
import type { BakeBundle, BakeSample, FaceParamId, ParamAssignment } from './types';

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

const sample = (
    id: string,
    kind: BakeSample['kind'],
    family: FaceParamId | undefined,
    vertices: { screenX: number[]; screenY: number[]; depth: number[] },
): BakeSample => ({
    id,
    kind,
    family,
    index: 0,
    assignment: assignment(family === 'ParamAngleX' ? { ParamAngleX: 10 } : family === 'ParamMouthOpenY' ? { ParamMouthOpenY: 1 } : {}),
    viewport: { width: 1024, height: 1024 },
    meshes: [meshSample(vertices.screenX, vertices.screenY, vertices.depth)],
});

const buildBundle = (): BakeBundle => ({
    schemaVersion: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
    modelName: 'test',
    params: [],
    parts: [
        { leafId: 'face', label: 'face', meshId: 'mesh-1', color: '#ff0000', triangleCount: 1, triangles: [[0, 1, 2]] },
        { leafId: 'torso', label: 'torso', meshId: 'mesh-1', color: '#00ff00', triangleCount: 1, triangles: [[3, 4, 5]] },
    ],
    samples: [
        sample('neutral', 'neutral', undefined, {
            screenX: [0, 0, 0, 0, 0, 0],
            screenY: [0, 0, 0, 0, 0, 0],
            depth: [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
        }),
        sample('yaw-a', 'family-sweep', 'ParamAngleX', {
            screenX: [3, 3, 3, 0, 0, 0],
            screenY: [4, 4, 4, 0, 0, 0],
            depth: [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
        }),
        sample('yaw-b', 'family-sweep', 'ParamAngleX', {
            screenX: [0, 0, 0, 0, 0, 0],
            screenY: [3, 3, 3, 0, 0, 0],
            depth: [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
        }),
        sample('mouth', 'family-sweep', 'ParamMouthOpenY', {
            screenX: [0, 0, 0, 2, 2, 2],
            screenY: [0, 0, 0, 0, 0, 0],
            depth: [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
        }),
        sample('combo', 'combo-qa', undefined, {
            screenX: [9, 9, 9, 9, 9, 9],
            screenY: [0, 0, 0, 0, 0, 0],
            depth: [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
        }),
    ],
});

describe('bake summary', () => {
    it('computes per-part motion energy against the neutral sample', () => {
        const summary = summarizeBake(buildBundle());

        const faceYaw = summary.motion.find((entry) => entry.leafId === 'face' && entry.family === 'ParamAngleX')!;
        expect(faceYaw.maxDisplacementPx).toBeCloseTo(5);
        expect(faceYaw.meanDisplacementPx).toBeCloseTo(5);

        const torsoYaw = summary.motion.find((entry) => entry.leafId === 'torso' && entry.family === 'ParamAngleX')!;
        expect(torsoYaw.maxDisplacementPx).toBe(0);

        const torsoMouth = summary.motion.find((entry) => entry.leafId === 'torso' && entry.family === 'ParamMouthOpenY')!;
        expect(torsoMouth.maxDisplacementPx).toBeCloseTo(2);
    });

    it('counts moving parts per family above the pixel threshold', () => {
        const summary = summarizeBake(buildBundle());
        expect(summary.movingLeafCountByFamily.ParamAngleX).toBe(1);
        expect(summary.movingLeafCountByFamily.ParamMouthOpenY).toBe(1);
    });

    it('combo samples do not leak into family motion stats', () => {
        const summary = summarizeBake(buildBundle());
        const faceFamilies = summary.motion.filter((entry) => entry.leafId === 'face');
        expect(faceFamilies.every((entry) => entry.maxDisplacementPx <= 5)).toBe(true);
    });

    it('reports median neutral depth per part for draw ordering', () => {
        const summary = summarizeBake(buildBundle());
        const face = summary.depthAtNeutral.find((entry) => entry.leafId === 'face')!;
        const torso = summary.depthAtNeutral.find((entry) => entry.leafId === 'torso')!;
        expect(face.medianDepthAtNeutral).toBeCloseTo(0.2);
        expect(torso.medianDepthAtNeutral).toBeCloseTo(0.8);
    });

    it('digests sample counts and param resolution', () => {
        const summary = summarizeBake(buildBundle());
        expect(summary.sampleCounts).toEqual({ total: 5, neutral: 1, familySweep: 3, comboQa: 1 });

        const digest = familyDigest(summary);
        expect(digest).toContainEqual({ family: 'ParamAngleX', movingParts: 1, totalParts: 2 });
        expect(digest).toContainEqual({ family: 'ParamMouthOpenY', movingParts: 1, totalParts: 2 });
    });
});
