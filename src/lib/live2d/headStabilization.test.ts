import { describe, expect, it } from 'vitest';
import type { DrawableDecomposition } from './decomposition';
import type { FamilyKeyforms } from './keyforms';
import { stabilizeHeadAngleKeyforms } from './headStabilization';

const drawable = (label: string, vertexCount: number): DrawableDecomposition => ({
    id: label,
    label,
    meshId: 'mesh',
    leafIds: [label],
    triangleCount: 1,
    meshVertexIndices: Uint32Array.from({ length: vertexCount }, (_, index) => index),
    triangles: Uint32Array.from([0, Math.min(1, vertexCount - 1), Math.min(2, vertexCount - 1)]),
    vertexCount,
});

const family = (id: 'ParamAngleX' | 'ParamAngleY', displacement: number[]): FamilyKeyforms => ({
    family: id,
    default: 0,
    values: [-30],
    displacements: [Float32Array.from(displacement)],
});

describe('head angle stabilization', () => {
    it('stabilizes front hair at yaw without erasing facial turn cues', () => {
        const drawables = [drawable('D颜', 4), drawable('D目', 2), drawable('D前髪', 2)];
        const neutral = [
            Float32Array.from([-1, -1, 1, -1, -1, 1, 1, 1]),
            Float32Array.from([-0.5, 0, 0.5, 0]),
            Float32Array.from([-1, -2, 1, -2]),
        ];
        const raw = [
            // Face translates by (+5,+2); eye keeps its turn cue while the
            // bangs contain a bad crossing displacement.
            5, 2, 5, 2, 5, 2, 5, 2,
            15, 2, 15, 2,
            -4, 2, -4, 2,
        ];
        const stabilized = stabilizeHeadAngleKeyforms(drawables, neutral, {
            ParamAngleX: family('ParamAngleX', raw),
        });
        const output = stabilized.ParamAngleX.displacements[0];

        expect([...output.slice(0, 8)]).toEqual(raw.slice(0, 8));
        expect([...output.slice(8, 12)]).toEqual([15, 2, 15, 2]);
        expect([...output.slice(12, 16)]).toEqual([5, 2, 5, 2]);
    });

    it('removes pitch squash from the face and every facial feature', () => {
        const drawables = [drawable('face', 4), drawable('double eyelid', 2)];
        const neutral = [
            Float32Array.from([-1, -1, 1, -1, -1, 1, 1, 1]),
            Float32Array.from([-0.5, 0, 0.5, 0]),
        ];
        const raw = [
            // Target face is translated (+3,+4) and stretched 2x vertically.
            3, 3, 3, 3, 3, 5, 3, 5,
            20, -10, 20, -10,
        ];
        const stabilized = stabilizeHeadAngleKeyforms(drawables, neutral, {
            ParamAngleY: family('ParamAngleY', raw),
        });
        const output = stabilized.ParamAngleY.displacements[0];

        expect([...output.slice(0, 8)]).toEqual([3, 4, 3, 4, 3, 4, 3, 4]);
        expect([...output.slice(8, 12)]).toEqual([3, 4, 3, 4]);
    });

    it('pins hair roots while retaining restrained motion at long tips', () => {
        const drawables = [drawable('D颜', 4), drawable('D髪', 2)];
        const neutral = [
            Float32Array.from([0, 0, 10, 0, 0, 10, 10, 10]),
            Float32Array.from([5, 8, 5, 25]),
        ];
        const raw = [
            4, 0, 4, 0, 4, 0, 4, 0,
            20, 0, 20, 0,
        ];
        const stabilized = stabilizeHeadAngleKeyforms(drawables, neutral, {
            ParamAngleY: family('ParamAngleY', raw),
        });
        const output = stabilized.ParamAngleY.displacements[0];

        expect(output[8]).toBeCloseTo(4);
        expect(output[10]).toBeGreaterThan(4);
        expect(output[10]).toBeLessThanOrEqual(4 + (20 - 4) * 0.4 + 1e-6);
    });

    it('leaves non-angle families and models without a face anchor unchanged', () => {
        const noFace = [drawable('body', 3)];
        const neutral = [Float32Array.from([0, 0, 1, 0, 0, 1])];
        const angle = family('ParamAngleX', [1, 2, 1, 2, 1, 2]);
        const blink = {
            ...family('ParamAngleY', [3, 4, 3, 4, 3, 4]),
            family: 'ParamEyeLOpen' as const,
        };
        const families = { ParamAngleX: angle, ParamEyeLOpen: blink };

        expect(stabilizeHeadAngleKeyforms(noFace, neutral, families)).toBe(families);
    });
});
