import { defaultAssignment } from './paramMapping';
import type {
    BakeSampleKind,
    FaceParamDefinition,
    FaceParamId,
    ParamAssignment,
} from './types';

/**
 * Sampling protocol for a face bake:
 *   1 neutral sample,
 *   1D sweeps per family (other params at defaults),
 *   N seeded random combination samples for measuring additive-composition
 *     error later (M2 keyform fitting consumes them).
 *
 * Everything here is pure and deterministic: the same seed yields the same
 * plan, which is what makes bake determinism checkable.
 */

const DEFAULT_SWEEP_STEPS: Record<FaceParamId, number> = {
    ParamAngleX: 5,
    ParamAngleY: 5,
    ParamAngleZ: 5,
    ParamEyeLOpen: 0.125,
    ParamEyeROpen: 0.125,
    ParamMouthOpenY: 0.125,
};

export const mulberry32 = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

export const sweepValues = (param: FaceParamDefinition, step: number): number[] => {
    const count = Math.max(1, Math.round((param.max - param.min) / step));
    const values: number[] = [];
    for (let index = 0; index <= count; index += 1) {
        const value = param.min + (index * (param.max - param.min)) / count;
        values.push(Number(value.toFixed(4)));
    }
    return values;
};

export const assignmentWithOverride = (
    params: FaceParamDefinition[],
    family: FaceParamId,
    value: number,
): ParamAssignment => {
    const assignment = defaultAssignment(params);
    assignment[family] = value;
    return assignment;
};

export type SamplePlanEntry = {
    id: string;
    kind: BakeSampleKind;
    family?: FaceParamId;
    index: number;
    assignment: ParamAssignment;
};

export const buildSamplePlan = (
    params: FaceParamDefinition[],
    options: {
        sweepSteps?: Partial<Record<FaceParamId, number>>;
        comboCount?: number;
        seed?: number;
    } = {},
): SamplePlanEntry[] => {
    const { sweepSteps = {}, comboCount = 100, seed = 0x5eed2d2 } = options;
    const entries: SamplePlanEntry[] = [];
    let index = 0;

    entries.push({
        id: 'neutral/000',
        kind: 'neutral',
        index: index++,
        assignment: defaultAssignment(params),
    });

    params.forEach((param) => {
        const step = sweepSteps[param.id] ?? DEFAULT_SWEEP_STEPS[param.id];
        sweepValues(param, step).forEach((value) => {
            entries.push({
                id: `family/${param.id}/${entries.length}`,
                kind: 'family-sweep',
                family: param.id,
                index: index++,
                assignment: assignmentWithOverride(params, param.id, value),
            });
        });
    });

    const random = mulberry32(seed);
    for (let comboIndex = 0; comboIndex < comboCount; comboIndex += 1) {
        const assignment = defaultAssignment(params);
        params.forEach((param) => {
            const raw = param.min + random() * (param.max - param.min);
            assignment[param.id] = Number(raw.toFixed(3));
        });
        entries.push({
            id: `combo/${comboIndex}`,
            kind: 'combo-qa',
            index: index++,
            assignment,
        });
    }

    return entries;
};
