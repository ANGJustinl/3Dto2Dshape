import { describe, expect, it } from 'vitest';
import { applyExpression, parseExpression } from './expression';
import { createDemoIdleMotion, evaluateCurve, evaluateMotion, parseMotion } from './motion';
import type { ParamAssignment } from './types';

describe('motion3.json parsing and evaluation', () => {
    it('parses linear, bezier and stepped segments', () => {
        const motion = parseMotion({
            Meta: { Duration: 2, Fps: 30, Loop: true },
            Curves: [
                // linear 0->10 over [0,1], then hold 10 over [1,2]
                { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 1, 10, 1, 2, 10] },
                // stepped: 1 until t=1, then 0
                { Target: 'PartOpacity', Id: 'PartA', Segments: [0, 1, 3, 1, 0] },
                // bezier from (0,0) to (1,10) with control points pulling low
                { Target: 'Parameter', Id: 'ParamAngleY', Segments: [0, 0, 2, 0.3, 1, 0.7, 9, 1, 10] },
            ],
        });
        expect(motion.duration).toBe(2);
        expect(motion.curves).toHaveLength(3);

        const angleX = motion.curves[0];
        expect(evaluateCurve(angleX.segments, 0.5)).toBeCloseTo(5);
        expect(evaluateCurve(angleX.segments, 1.5)).toBe(10);
        expect(evaluateCurve(angleX.segments, -1)).toBe(0);
        expect(evaluateCurve(angleX.segments, 99)).toBe(10);

        const part = motion.curves[1];
        expect(evaluateCurve(part.segments, 0.5)).toBe(1);
        expect(evaluateCurve(part.segments, 1.5)).toBe(0);

        const angleY = motion.curves[2];
        // Bezier midpoint should be pulled below the linear 5 by the low
        // control points but stay within (0, 10).
        const mid = evaluateCurve(angleY.segments, 0.5);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(10);
        expect(evaluateCurve(angleY.segments, 1)).toBeCloseTo(10);
    });

    it('loops and clamps evaluation time', () => {
        const motion = parseMotion({
            Meta: { Duration: 2, Loop: true },
            Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 2, 30] }],
        });
        expect(evaluateMotion(motion, 3).parameters.ParamAngleX).toBeCloseTo(15); // t=1 after one loop
        const nonLoop = parseMotion({
            Meta: { Duration: 2, Loop: false },
            Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 2, 30] }],
        });
        expect(evaluateMotion(nonLoop, 99).parameters.ParamAngleX).toBeCloseTo(30);
    });

    it('rejects malformed documents', () => {
        expect(() => parseMotion({})).toThrow('Curves array missing');
        expect(() => parseMotion({ Curves: [{ Id: 'x', Segments: [0, 0, 7, 1, 1] }] })).toThrow('Unknown motion segment type');
    });

    it('demo idle motion only contains model params and evaluates in range', () => {
        const demo = createDemoIdleMotion([
            { id: 'ParamAngleX', min: -30, max: 30, default: 0 },
            { id: 'ParamEyeLOpen', min: 0, max: 1, default: 1 },
        ]);
        const ids = new Set(demo.curves.map((curve) => curve.id));
        expect(ids).toEqual(new Set(['ParamAngleX', 'ParamEyeLOpen']));
        for (let t = 0; t <= demo.duration; t += 0.1) {
            const sample = evaluateMotion(demo, t);
            Object.values(sample.parameters).forEach((value) => {
                expect(value).toBeGreaterThanOrEqual(-30);
                expect(value).toBeLessThanOrEqual(30);
            });
        }
        // Blink actually closes the eye somewhere around t=1.2.
        const blink = evaluateMotion(demo, 1.24).parameters.ParamEyeLOpen;
        expect(blink).toBeLessThan(0.5);
    });
});

describe('expressions', () => {
    const base = (): ParamAssignment => ({
        ParamAngleX: 10,
        ParamAngleY: 0,
        ParamAngleZ: 0,
        ParamEyeLOpen: 1,
        ParamEyeROpen: 1,
        ParamMouthOpenY: 0.5,
    });

    it('applies add, multiply and overwrite blends and ignores unknown ids', () => {
        const expression = parseExpression({
            Type: 'Live2D Expression',
            Parameters: [
                { Id: 'ParamAngleX', Value: 5, Blend: 'add' },
                { Id: 'ParamMouthOpenY', Value: 0.5, Blend: 'multiply' },
                { Id: 'ParamAngleZ', Value: -12, Blend: 'overwrite' },
                { Id: 'ParamNotInModel', Value: 99 },
            ],
        });
        const result = applyExpression(base(), expression);
        expect(result.ParamAngleX).toBeCloseTo(15);
        expect(result.ParamMouthOpenY).toBeCloseTo(0.25);
        expect(result.ParamAngleZ).toBe(-12);
        expect('ParamNotInModel' in result).toBe(false);
    });

    it('weights blends between 0 and 1', () => {
        const expression = parseExpression({
            Parameters: [{ Id: 'ParamAngleX', Value: 20, Blend: 'overwrite' }],
        });
        expect(applyExpression(base(), expression, 0.5).ParamAngleX).toBeCloseTo(15);
        expect(applyExpression(base(), expression, 0).ParamAngleX).toBeCloseTo(10);
    });

    it('rejects non-expression documents', () => {
        expect(() => parseExpression({})).toThrow('Parameters array missing');
    });
});
