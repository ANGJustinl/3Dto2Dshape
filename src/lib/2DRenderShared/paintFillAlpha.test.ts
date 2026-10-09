import { expect, it } from 'vitest';
import { paintFillAlphaScale, shapeAlpha } from './opacity';

it('keeps opaque paint opaque when stabilizing a soft fill', () => {
    expect(paintFillAlphaScale('soft', shapeAlpha(1, 1), true)).toBe(1);
    expect(paintFillAlphaScale('soft', shapeAlpha(undefined, 1), true)).toBe(1);
});

it('preserves the legacy soft-fill appearance when the experiment is disabled', () => {
    expect(paintFillAlphaScale('soft', 1)).toBe(0.92);
    expect(paintFillAlphaScale('soft', 1, false)).toBe(0.92);
});

it('preserves intentionally transparent material and global overlay alpha', () => {
    expect(paintFillAlphaScale('soft', shapeAlpha(.3, 1), true)).toBe(.92);
    expect(paintFillAlphaScale('soft', shapeAlpha(1, .5), true)).toBe(.92);
    expect(paintFillAlphaScale('soft', shapeAlpha(.999, 1), true)).toBe(.92);
    expect(shapeAlpha(.3, .5) * paintFillAlphaScale('soft', .15, true)).toBeCloseTo(.138);
});

it('leaves hard and open styles unchanged', () => {
    for (const stabilize of [false, true]) {
        expect(paintFillAlphaScale('hard', 1, stabilize)).toBe(1);
        expect(paintFillAlphaScale('open', 1, stabilize)).toBe(1);
    }
});
