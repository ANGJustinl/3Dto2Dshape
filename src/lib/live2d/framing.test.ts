import { describe, expect, it } from 'vitest';
import type { FamilyKeyforms } from './keyforms';
import { conservativeGeometryBounds, frameGeometryToViewport } from './framing';

const family = (blocks: number[][]): FamilyKeyforms => ({
    family: 'ParamAngleY',
    default: 0,
    values: blocks.map((_block, index) => index),
    displacements: blocks.map((block) => Float32Array.from(block)),
});

describe('Live2D geometry framing', () => {
    it('centers an almost-full-height model without scaling and keeps a safe margin', () => {
        const neutral = [Float32Array.from([215, -16, 809, 959])];
        const framed = frameGeometryToViewport(neutral, {}, { width: 1024, height: 1024 }, 24);

        expect(framed.transform.scale).toBe(1);
        expect(framed.transform.framedBounds.minY).toBeCloseTo(24.5);
        expect(framed.transform.framedBounds.maxY).toBeCloseTo(999.5);
        expect(framed.neutralPositions[0][1]).toBeCloseTo(24.5);
        expect(framed.neutralPositions[0][3]).toBeCloseTo(999.5);
    });

    it('includes independent family extremes and scales their displacements uniformly', () => {
        const neutral = [Float32Array.from([100, 100, 200, 200])];
        const families = {
            ParamAngleY: family([
                [-40, -80, 0, 0],
                [20, 50, 60, 90],
            ]),
        };
        const bounds = conservativeGeometryBounds(neutral, families);
        expect(bounds).toEqual({ minX: 60, minY: 20, maxX: 260, maxY: 290 });

        const framed = frameGeometryToViewport(neutral, families, { width: 200, height: 200 }, 20);
        expect(framed.transform.scale).toBeCloseTo(160 / 270);
        expect(framed.transform.framedBounds.minY).toBeCloseTo(20);
        expect(framed.transform.framedBounds.maxY).toBeCloseTo(180);
        expect(framed.families.ParamAngleY.displacements[0][1]).toBeCloseTo(
            -80 * framed.transform.scale,
        );
    });
});
