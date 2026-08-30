import { describe, expect, it } from 'vitest';
import { FACE_PARAM_DEFINITIONS } from './paramMapping';
import { assignmentWithOverride, buildSamplePlan, sweepValues } from './sampling';

describe('face bake sampling protocol', () => {
    it('sweeps angle families over 13 values and morph families over 9', () => {
        const angle = FACE_PARAM_DEFINITIONS.find((param) => param.id === 'ParamAngleX')!;
        expect(sweepValues(angle, 5)).toEqual([
            -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30,
        ]);

        const eye = FACE_PARAM_DEFINITIONS.find((param) => param.id === 'ParamEyeLOpen')!;
        expect(sweepValues(eye, 0.125)).toHaveLength(9);
        expect(sweepValues(eye, 0.125)[0]).toBe(0);
        expect(sweepValues(eye, 0.125)[8]).toBe(1);
    });

    it('starts with one neutral sample, then family sweeps, then combos', () => {
        const plan = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 10 });
        expect(plan[0].kind).toBe('neutral');
        expect(plan[0].assignment.ParamEyeLOpen).toBe(1);
        expect(plan[0].assignment.ParamMouthOpenY).toBe(0);

        const kinds = plan.map((entry) => entry.kind);
        expect(kinds.filter((kind) => kind === 'neutral')).toHaveLength(1);
        expect(kinds.filter((kind) => kind === 'family-sweep')).toHaveLength(13 * 3 + 9 * 3);
        expect(kinds.filter((kind) => kind === 'combo-qa')).toHaveLength(10);

        const firstSweepIndex = kinds.indexOf('family-sweep');
        expect(kinds.slice(firstSweepIndex, firstSweepIndex + 13).every((kind) => kind === 'family-sweep')).toBe(true);
    });

    it('family sweeps keep all other params at defaults', () => {
        const plan = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 0 });
        const sweep = plan.find(
            (entry) => entry.kind === 'family-sweep' && entry.family === 'ParamMouthOpenY' && entry.assignment.ParamMouthOpenY === 1,
        );
        expect(sweep).toBeDefined();
        expect(sweep!.assignment.ParamAngleX).toBe(0);
        expect(sweep!.assignment.ParamEyeLOpen).toBe(1);
    });

    it('is deterministic for a fixed seed and differs across seeds', () => {
        const planA = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 20, seed: 42 });
        const planB = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 20, seed: 42 });
        const planC = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 20, seed: 43 });

        expect(planA).toEqual(planB);
        expect(planA).not.toEqual(planC);

        const combosA = planA.filter((entry) => entry.kind === 'combo-qa');
        const combosC = planC.filter((entry) => entry.kind === 'combo-qa');
        expect(combosA.some((entry, index) => entry.assignment.ParamAngleX !== combosC[index].assignment.ParamAngleX)).toBe(true);
    });

    it('combo values stay within param ranges', () => {
        const plan = buildSamplePlan(FACE_PARAM_DEFINITIONS, { comboCount: 50, seed: 7 });
        plan
            .filter((entry) => entry.kind === 'combo-qa')
            .forEach((entry) => {
                FACE_PARAM_DEFINITIONS.forEach((param) => {
                    const value = entry.assignment[param.id];
                    expect(value).toBeGreaterThanOrEqual(param.min);
                    expect(value).toBeLessThanOrEqual(param.max);
                });
            });
    });

    it('assignmentWithOverride clones the defaults', () => {
        const base = assignmentWithOverride(FACE_PARAM_DEFINITIONS, 'ParamAngleX', 12);
        expect(base.ParamAngleX).toBe(12);
        expect(base.ParamAngleZ).toBe(0);
    });
});
