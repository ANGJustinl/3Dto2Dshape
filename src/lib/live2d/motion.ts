import type { FaceParamId } from './types';

/**
 * L1: Cubism motion3.json import. The JSON motion format is documented in the
 * Cubism SDK; curves target Parameters (our FaceParamIds already use the
 * standard IDs) or PartOpacity (mapped onto drawable ids where they match).
 */

// Cubism wire values, not one-based internal ordinals.
type SegmentType = 0 | 1 | 2 | 3;
export type MotionEncoding = 'cubism' | 'legacy-one-based';

type ParsedSegment = {
    type: SegmentType;
    t0: number;
    v0: number;
    t1: number;
    v1: number;
    c1?: [number, number];
    c2?: [number, number];
};

export type ParsedCurve = {
    target: string;
    id: string;
    segments: ParsedSegment[];
};

export type ParsedMotion = {
    duration: number;
    fps: number;
    loop: boolean;
    curves: ParsedCurve[];
    userData: Array<{ time: number; value: string }>;
    sourceEncoding?: MotionEncoding;
};

const readSegments = (flat: number[], encoding: MotionEncoding = 'cubism'): ParsedSegment[] => {
    if (flat.length < 2 || flat.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Motion curve segments must start with a time/value pair.');
    }
    const segments: ParsedSegment[] = [];
    let cursor = 0;
    let t0 = flat[cursor++];
    let v0 = flat[cursor++];
    while (cursor < flat.length) {
        const wireType = flat[cursor++];
        const type = (wireType - (encoding === 'legacy-one-based' ? 1 : 0)) as SegmentType;
        if (type !== 0 && type !== 1 && type !== 2 && type !== 3) {
            throw new Error(`Unknown motion segment type ${wireType}.`);
        }
        const points = type === 1 ? 6 : 2;
        if (cursor + points > flat.length) throw new Error('Truncated motion curve segment.');
        if (type === 0 || type === 2 || type === 3) {
            const t1 = flat[cursor++];
            const v1 = flat[cursor++];
            if (t1 < t0) throw new Error('Motion curve times must not decrease.');
            segments.push({ type, t0, v0, t1, v1 });
            t0 = t1;
            v0 = v1;
        } else {
            const c1: [number, number] = [flat[cursor++], flat[cursor++]];
            const c2: [number, number] = [flat[cursor++], flat[cursor++]];
            const t1 = flat[cursor++];
            const v1 = flat[cursor++];
            if (t1 < t0 || c1[0] < t0 || c1[0] > t1 || c2[0] < t0 || c2[0] > t1) throw new Error('Invalid motion Bezier time controls.');
            segments.push({ type, t0, v0, t1, v1, c1, c2 });
            t0 = t1;
            v0 = v1;
        }
    }
    // A one-key curve is a constant, including after its key time.
    if (segments.length === 0) segments.push({ type: 0, t0, v0, t1: t0, v1: v0 });
    return segments;
};

export const parseMotion = (json: unknown, options: { encoding?: MotionEncoding } = {}): ParsedMotion => {
    const source = json as {
        Meta?: { Duration?: number; Fps?: number; Loop?: boolean; CurveCount?: number; TotalSegmentCount?: number; TotalPointCount?: number };
        Curves?: Array<{ Target?: string; Id?: string; Segments?: number[] }>;
        UserData?: Array<{ Time?: number; Value?: string }>;
    };
    if (!source || !Array.isArray(source.Curves)) {
        throw new Error('Not a motion3.json document: Curves array missing.');
    }
    const duration = source.Meta?.Duration ?? 0;
    const fps = source.Meta?.Fps ?? 30;
    if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid motion duration or frame rate.');
    const decode = (encoding: MotionEncoding): ParsedCurve[] => {
        let segmentCount = 0;
        let pointCount = 0;
        const curves = source.Curves!.map((curve) => {
            if (!curve || typeof curve.Id !== 'string' || !curve.Id || !Array.isArray(curve.Segments)) throw new Error('Motion curve ID or segments missing.');
            const segments = readSegments(curve.Segments, encoding);
            if (curve.Segments.length > 2) segmentCount += segments.length;
            pointCount += 1 + (curve.Segments.length > 2 ? segments.reduce((total, segment) => total + (segment.type === 1 ? 3 : 1), 0) : 0);
            return { target: curve.Target ?? 'Parameter', id: curve.Id, segments };
        });
        for (const [field, actual] of [['CurveCount', curves.length], ['TotalSegmentCount', segmentCount], ['TotalPointCount', pointCount]] as const) {
            const declared = source.Meta?.[field];
            if (declared !== undefined && declared !== actual) throw new Error(`Motion ${field} mismatch: expected ${declared}, read ${actual}.`);
        }
        return curves;
    };
    let sourceEncoding: MotionEncoding = options.encoding ?? 'cubism';
    let curves: ParsedCurve[];
    try {
        curves = decode(sourceEncoding);
    } catch (error) {
        // Earlier app recordings used 1..4. Only accept that interpretation
        // when standard decoding fails AND all independent counts are present.
        const completeCounts = ['CurveCount', 'TotalSegmentCount', 'TotalPointCount'].every((field) => {
            const value = source.Meta?.[field as 'CurveCount'];
            return typeof value === 'number' && Number.isInteger(value) && value >= 0;
        });
        if (options.encoding || !completeCounts) throw error;
        try {
            curves = decode('legacy-one-based');
            sourceEncoding = 'legacy-one-based';
        } catch {
            throw error;
        }
    }
    return {
        duration,
        fps,
        loop: source.Meta?.Loop ?? true,
        curves,
        sourceEncoding,
        userData: (source.UserData ?? []).flatMap((entry) =>
            typeof entry.Time === 'number' && typeof entry.Value === 'string'
                ? [{ time: entry.Time, value: entry.Value }]
                : [],
        ),
    };
};

const bezierYAtTime = (segment: ParsedSegment, time: number) => {
    // Cubic bezier over (t, v) with absolute control points; solve the time
    // axis by bisection (control layouts from Cubism keep x monotonic).
    const { t0, v0, t1, v1, c1, c2 } = segment;
    const x = (u: number) => {
        const w = 1 - u;
        return w * w * w * t0 + 3 * w * w * u * c1![0] + 3 * w * u * u * c2![0] + u * u * u * t1;
    };
    const y = (u: number) => {
        const w = 1 - u;
        return w * w * w * v0 + 3 * w * w * u * c1![1] + 3 * w * u * u * c2![1] + u * u * u * v1;
    };
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 24; iteration += 1) {
        const mid = (low + high) / 2;
        if (x(mid) < time) {
            low = mid;
        } else {
            high = mid;
        }
    }
    return y((low + high) / 2);
};

export const evaluateCurve = (segments: ParsedSegment[], time: number): number => {
    if (segments.length === 0) {
        return 0;
    }
    if (time < segments[0].t0) {
        return segments[0].v0;
    }
    for (const segment of segments) {
        if (time < segment.t1 || segment === segments[segments.length - 1]) {
            if (segment.type === 0) {
                const span = segment.t1 - segment.t0;
                const t = span > 1e-9 ? (time - segment.t0) / span : 1;
                return segment.v0 + (segment.v1 - segment.v0) * Math.min(1, Math.max(0, t));
            }
            if (segment.type === 1) {
                if (time >= segment.t1) {
                    return segment.v1;
                }
                return bezierYAtTime(segment, time);
            }
            if (segment.type === 2) {
                return time >= segment.t1 ? segment.v1 : segment.v0;
            }
            return time >= segment.t0 ? segment.v1 : segment.v0;
        }
    }
    return segments[segments.length - 1].v1;
};

export type MotionSample = {
    parameters: Partial<Record<FaceParamId, number>>;
    partOpacities: Record<string, number>;
};

export const evaluateMotion = (motion: ParsedMotion, timeSeconds: number): MotionSample => {
    const duration = motion.duration;
    let time = timeSeconds;
    if (duration > 0) {
        if (motion.loop) {
            time = ((time % duration) + duration) % duration;
        } else {
            time = Math.min(time, duration);
        }
    }

    const sample: MotionSample = { parameters: {}, partOpacities: {} };
    const effects: Record<string, number> = {};
    motion.curves.forEach((curve) => {
        const value = evaluateCurve(curve.segments, time);
        if (curve.target === 'Parameter') {
            sample.parameters[curve.id as FaceParamId] = value;
        } else if (curve.target === 'PartOpacity') {
            sample.partOpacities[curve.id] = value;
        } else if (curve.target === 'Model') {
            effects[curve.id] = value;
        }
    });
    if (effects.EyeBlink !== undefined) {
        for (const id of ['ParamEyeLOpen', 'ParamEyeROpen'] as const) sample.parameters[id] = (sample.parameters[id] ?? 1) * effects.EyeBlink;
    }
    if (effects.LipSync !== undefined) sample.parameters.ParamMouthOpenY = (sample.parameters.ParamMouthOpenY ?? 0) + effects.LipSync;
    return sample;
};

/**
 * A built-in idle motion so the pipeline is demonstrable without external
 * assets: slow head sway, periodic blinks and gentle mouth movement.
 */
export const createDemoIdleMotion = (
    params: Array<Pick<import('./model').Live2dParamDefinition, 'id' | 'min' | 'max' | 'default'>>,
): ParsedMotion => {
    const clamp = (id: FaceParamId, value: number) => {
        const param = params.find((candidate) => candidate.id === id);
        if (!param) {
            return value;
        }
        return Math.min(param.max, Math.max(param.min, value));
    };
    const has = (id: string) => params.some((candidate) => candidate.id === id);
    const flat = (id: string, flatSegments: number[]): ParsedCurve => ({
        target: 'Parameter',
        id,
        segments: readSegments(flatSegments),
    });
    const duration = 8;
    const curves: ParsedCurve[] = [];

    if (has('ParamAngleX')) {
        const segments: number[] = [0, 0];
        for (let t = 0; t <= duration; t += 1) {
            segments.push(0, t, clamp('ParamAngleX', 14 * Math.sin((t / duration) * Math.PI * 2)));
        }
        curves.push(flat('ParamAngleX', segments));
    }
    if (has('ParamAngleY')) {
        const segments: number[] = [0, 0];
        for (let t = 0; t <= duration; t += 1) {
            segments.push(0, t, clamp('ParamAngleY', 6 * Math.sin(((t + 2) / duration) * Math.PI * 2)));
        }
        curves.push(flat('ParamAngleY', segments));
    }
    // Blinks at t=1.2 and t=4.8 as ONE curve per eye param (motion files
    // carry one curve per id; later same-id curves would overwrite).
    (['ParamEyeLOpen', 'ParamEyeROpen'] as FaceParamId[]).forEach((id) => {
        if (!has(id)) {
            return;
        }
        curves.push(
            flat(id, [
                0, 1,
                0, 1.2, 1, 0, 1.28, 0, 0, 1.42, 1,
                0, 4.8, 1, 0, 4.88, 0, 0, 4.92, 1,
                0, duration, 1,
            ]),
        );
    });
    if (has('ParamMouthOpenY')) {
        curves.push(
            flat('ParamMouthOpenY', [0, 0, 0, 1.5, 0.35, 0, 2.5, 0.15, 0, 3.5, 0.45, 0, 4.5, 0, 0, duration, 0]),
        );
    }

    return { duration, fps: 30, loop: true, curves, userData: [] };
};
