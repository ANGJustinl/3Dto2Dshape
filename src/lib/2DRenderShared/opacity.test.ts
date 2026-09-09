import { expect, it } from 'vitest';
import { shapeAlpha } from './opacity';

it('preserves eye-shadow material alpha and composes it with overlay/outline alpha', () => {
    expect(shapeAlpha(0.3, 1)).toBeCloseTo(0.3);
    expect(shapeAlpha(0.3, 0.5)).toBeCloseTo(0.15);
    expect(shapeAlpha(0, 1)).toBe(0);
    expect(shapeAlpha(undefined, 0.8)).toBe(0.8);
    expect(shapeAlpha(1, 1)).toBe(1);
    expect(shapeAlpha(-1, 2)).toBe(0);
});
