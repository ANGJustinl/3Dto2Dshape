import type { DrawableDecomposition } from './decomposition';
import { drawableNeutralPositions } from './decomposition';
import { medianDepth } from './order';
import type { BakeBundle, FaceParamId, ParamAssignment } from './types';

/**
 * M2: keyform construction and additive-composition interpolation.
 *
 * Per family, the sweep samples become keyforms stored as DISPLACEMENTS from
 * the neutral sample. Any param value is evaluated by piecewise-linear
 * interpolation inside one family, and the final pose is the neutral position
 * plus the sum of all family displacements. The combo-QA samples exist to
 * measure exactly how much this additivity approximation costs.
 */

export type FamilyKeyforms = {
    family: FaceParamId;
    /** Neutral (default) param value; displacement is zero there by definition. */
    default: number;
    /** Swept param values, ascending (keyform parameter positions). */
    values: number[];
    /**
     * displacements[drawableIndex][k * vertexCount * 2 + v * 2 (+1)] is the
     * xy displacement of drawable vertex v at keyform k.
     */
    displacements: Float32Array[];
};

export const buildFamilyKeyforms = (
    bundle: BakeBundle,
    drawables: DrawableDecomposition[],
): Record<string, FamilyKeyforms> => {
    const neutral = bundle.samples.find((sample) => sample.kind === 'neutral');
    const families: Record<string, FamilyKeyforms> = {};
    if (!neutral) {
        return families;
    }

    const neutralByDrawable = drawables.map((drawable) => drawableNeutralPositions(drawable, neutral));

    const familyIds = [
        ...new Set(
            bundle.samples
                .filter((sample) => sample.kind === 'family-sweep' && sample.family)
                .map((sample) => sample.family as FaceParamId),
        ),
    ];

    familyIds.forEach((family) => {
        const sweepSamples = bundle.samples
            .filter((sample) => sample.family === family)
            .sort((left, right) => {
                const leftValue = left.assignment[family];
                const rightValue = right.assignment[family];
                return leftValue - rightValue;
            });

        const values = sweepSamples.map((sample) => sample.assignment[family]);
        const displacements = sweepSamples.map((sample, keyformIndex) => {
            const packed = new Float32Array(
                drawables.reduce((total, drawable) => total + drawable.vertexCount * 2, 0),
            );
            let offset = 0;
            drawables.forEach((drawable, drawableIndex) => {
                const meshVertices = sample.meshes.find(
                    (mesh) => mesh.meshId === drawable.meshId,
                )?.vertices;
                const neutralPositions = neutralByDrawable[drawableIndex];
                if (!meshVertices) {
                    offset += drawable.vertexCount * 2;
                    return;
                }
                for (let v = 0; v < drawable.vertexCount; v += 1) {
                    const meshVertexIndex = drawable.meshVertexIndices[v];
                    packed[offset + v * 2] =
                        meshVertices.screenX[meshVertexIndex] - neutralPositions[v * 2];
                    packed[offset + v * 2 + 1] =
                        meshVertices.screenY[meshVertexIndex] - neutralPositions[v * 2 + 1];
                }
                offset += drawable.vertexCount * 2;
            });
            void keyformIndex;
            return packed;
        });

        families[family] = {
            family,
            default: neutral.assignment[family] ?? values[0] ?? 0,
            values,
            displacements,
        };
    });

    return families;
};

/** drawableOffsets[i] is where drawable i's block starts inside each packed displacement. */
export const drawableDisplacementOffsets = (drawables: DrawableDecomposition[]): number[] => {
    const offsets: number[] = [];
    let offset = 0;
    drawables.forEach((drawable) => {
        offsets.push(offset);
        offset += drawable.vertexCount * 2;
    });
    return offsets;
};

const lerpDisplacementInto = (
    keyforms: FamilyKeyforms,
    value: number,
    drawableVertexCount: number,
    drawableOffset: number,
    output: Float32Array,
) => {
    const { values, displacements, default: defaultValue } = keyforms;
    if (values.length === 0) {
        return;
    }

    // A sweep that does not cover the default value gets a virtual zero-
    // displacement keyform there, so evaluating at the default (or anywhere
    // between default and the nearest swept value) contributes no motion.
    const hasLowerVirtual = defaultValue < values[0];
    const hasUpperVirtual = defaultValue > values[values.length - 1];
    const extendedValues = [
        ...(hasLowerVirtual ? [defaultValue] : []),
        ...values,
        ...(hasUpperVirtual ? [defaultValue] : []),
    ];
    const virtualBias = hasLowerVirtual ? 1 : 0;
    const displacementAt = (extendedIndex: number): Float32Array | null => {
        const realIndex = extendedIndex - virtualBias;
        if (realIndex < 0 || realIndex >= displacements.length) {
            return null; // virtual keyform: zero displacement
        }
        return displacements[realIndex];
    };

    const clamped = Math.max(
        extendedValues[0],
        Math.min(extendedValues[extendedValues.length - 1], value),
    );
    if (extendedValues.length === 1) {
        const only = displacements[0];
        if (only) {
            for (let index = drawableOffset; index < drawableOffset + drawableVertexCount * 2; index += 1) {
                output[index - drawableOffset] += only[index];
            }
        }
        return;
    }
    let upperIndex = 1;
    while (upperIndex < extendedValues.length && extendedValues[upperIndex] < clamped) {
        upperIndex += 1;
    }
    const lowerIndex = upperIndex - 1;
    const lowerValue = extendedValues[lowerIndex];
    const upperValue = extendedValues[upperIndex];
    const span = upperValue - lowerValue;
    const t = span > 1e-9 ? (clamped - lowerValue) / span : 0;

    const lower = displacementAt(lowerIndex);
    const upper = displacementAt(upperIndex);
    const start = drawableOffset;
    const end = start + drawableVertexCount * 2;
    if (lower && upper) {
        for (let index = start; index < end; index += 1) {
            output[index - start] += lower[index] + (upper[index] - lower[index]) * t;
        }
    } else if (lower) {
        // Blend from the real keyform toward zero displacement.
        for (let index = start; index < end; index += 1) {
            output[index - start] += lower[index] * (1 - t);
        }
    } else if (upper) {
        for (let index = start; index < end; index += 1) {
            output[index - start] += upper[index] * t;
        }
    }
};

export type PoseEvaluator = {
    /** Fills per-drawable xy positions (neutral + summed family displacements). */
    evaluate: (assignment: ParamAssignment, outputs: Float32Array[]) => void;
    familyIds: string[];
};

export const createPoseEvaluator = (
    drawables: Array<Pick<DrawableDecomposition, 'vertexCount'>>,
    neutralPositions: Float32Array[],
    families: Record<string, FamilyKeyforms>,
): PoseEvaluator => {
    const offsets = drawableDisplacementOffsets(
        drawables as DrawableDecomposition[],
    );
    const familyIds = Object.keys(families);
    const displacementScratch = drawables.map(
        (drawable) => new Float32Array(drawable.vertexCount * 2),
    );

    return {
        familyIds,
        evaluate: (assignment, outputs) => {
            drawables.forEach((_, drawableIndex) => {
                displacementScratch[drawableIndex].fill(0);
            });
            familyIds.forEach((familyId) => {
                const keyforms = families[familyId];
                // Missing assignment entries mean the parameter sits at its
                // default, not at the first key (values[0] is the min, e.g.
                // -30 for angles — defaulting there wrote the wrong pose
                // into every unbound tensor slot).
                const value =
                    assignment[familyId as FaceParamId] ?? keyforms.default ?? keyforms.values[0];
                drawables.forEach((drawable, drawableIndex) => {
                    lerpDisplacementInto(
                        keyforms,
                        value,
                        drawable.vertexCount,
                        offsets[drawableIndex],
                        displacementScratch[drawableIndex],
                    );
                });
            });
            drawables.forEach((drawable, drawableIndex) => {
                const neutral = neutralPositions[drawableIndex];
                const displacement = displacementScratch[drawableIndex];
                const output = outputs[drawableIndex];
                for (let index = 0; index < drawable.vertexCount * 2; index += 1) {
                    output[index] = neutral[index] + displacement[index];
                }
            });
        },
    };
};

export type ComboErrorReport = {    comboCount: number;
    meanErrorPx: number;
    maxErrorPx: number;
    /** Worst combos first, capped. */
    perCombo: Array<{ id: string; meanPx: number; maxPx: number }>;
    worstDrawable: { id: string; label: string; meanPx: number } | null;
};

export const evaluateComboError = (
    bundle: BakeBundle,
    drawables: DrawableDecomposition[],
    evaluator: PoseEvaluator,
): ComboErrorReport => {
    const outputs = drawables.map((drawable) => new Float32Array(drawable.vertexCount * 2));
    const drawableErrorSums = drawables.map(() => 0);
    const drawableVertexTotals = drawables.map(() => 0);
    let errorSum = 0;
    let errorCount = 0;
    let maxError = 0;
    const perCombo: Array<{ id: string; meanPx: number; maxPx: number }> = [];

    bundle.samples
        .filter((sample) => sample.kind === 'combo-qa')
        .forEach((sample) => {
            evaluator.evaluate(sample.assignment, outputs);
            let comboSum = 0;
            let comboCount = 0;
            let comboMax = 0;
            drawables.forEach((drawable, drawableIndex) => {
                const meshVertices = sample.meshes.find(
                    (mesh) => mesh.meshId === drawable.meshId,
                )?.vertices;
                if (!meshVertices) {
                    return;
                }
                const positions = outputs[drawableIndex];
                for (let v = 0; v < drawable.vertexCount; v += 1) {
                    const meshVertexIndex = drawable.meshVertexIndices[v];
                    const dx = positions[v * 2] - meshVertices.screenX[meshVertexIndex];
                    const dy = positions[v * 2 + 1] - meshVertices.screenY[meshVertexIndex];
                    const distance = Math.hypot(dx, dy);
                    comboSum += distance;
                    comboCount += 1;
                    comboMax = Math.max(comboMax, distance);
                    drawableErrorSums[drawableIndex] += distance;
                    drawableVertexTotals[drawableIndex] += 1;
                }
            });
            errorSum += comboSum;
            errorCount += comboCount;
            maxError = Math.max(maxError, comboMax);
            perCombo.push({
                id: sample.id,
                meanPx: comboCount > 0 ? comboSum / comboCount : 0,
                maxPx: comboMax,
            });
        });

    perCombo.sort((left, right) => right.maxPx - left.maxPx);

    let worstDrawable: ComboErrorReport['worstDrawable'] = null;
    drawables.forEach((drawable, drawableIndex) => {
        const total = drawableVertexTotals[drawableIndex];
        const mean = total > 0 ? drawableErrorSums[drawableIndex] / total : 0;
        if (!worstDrawable || mean > worstDrawable.meanPx) {
            worstDrawable = { id: drawable.id, label: drawable.label, meanPx: mean };
        }
    });

    return {
        comboCount: perCombo.length,
        meanErrorPx: errorCount > 0 ? errorSum / errorCount : 0,
        maxErrorPx: maxError,
        perCombo: perCombo.slice(0, 5),
        worstDrawable,
    };
};

/**
 * Dynamic draw order (M3+): per-drawable median depth as SCALAR keyforms.
 * The runtime re-sorts renderOrder from interpolated depths every frame,
 * which resolves the static-order flips detected by checkOrderConsistency.
 */

export type ScalarFamilyKeyforms = {
    family: FaceParamId;
    default: number;
    values: number[];
    /** displacements[k * drawableCount + drawableIndex]: depth displacement at keyform k. */
    displacements: Float32Array[];
};

export const buildDepthKeyforms = (
    bundle: BakeBundle,
    drawables: DrawableDecomposition[],
): Record<string, ScalarFamilyKeyforms> => {
    const neutral = bundle.samples.find((sample) => sample.kind === 'neutral');
    const families: Record<string, ScalarFamilyKeyforms> = {};
    if (!neutral) {
        return families;
    }
    const neutralDepths = drawables.map((drawable) => medianDepth(drawable, neutral));

    const familyIds = [
        ...new Set(
            bundle.samples
                .filter((sample) => sample.kind === 'family-sweep' && sample.family)
                .map((sample) => sample.family as FaceParamId),
        ),
    ];

    familyIds.forEach((family) => {
        const sweepSamples = bundle.samples
            .filter((sample) => sample.family === family)
            .sort((left, right) => left.assignment[family] - right.assignment[family]);

        const values = sweepSamples.map((sample) => sample.assignment[family]);
        const displacements = sweepSamples.map((sample) => {
            const packed = new Float32Array(drawables.length);
            drawables.forEach((drawable, drawableIndex) => {
                packed[drawableIndex] = medianDepth(drawable, sample) - neutralDepths[drawableIndex];
            });
            return packed;
        });

        families[family] = {
            family,
            default: neutral.assignment[family] ?? values[0] ?? 0,
            values,
            displacements,
        };
    });

    return families;
};

const lerpScalarInto = (
    keyforms: ScalarFamilyKeyforms,
    value: number,
    drawableIndex: number,
    output: Float32Array,
) => {
    const { values, displacements, default: defaultValue } = keyforms;
    if (values.length === 0) {
        return;
    }
    const hasLowerVirtual = defaultValue < values[0];
    const hasUpperVirtual = defaultValue > values[values.length - 1];
    const extended = [
        ...(hasLowerVirtual ? [defaultValue] : []),
        ...values,
        ...(hasUpperVirtual ? [defaultValue] : []),
    ];
    const virtualBias = hasLowerVirtual ? 1 : 0;
    const valueAt = (extendedIndex: number): number | null => {
        const realIndex = extendedIndex - virtualBias;
        if (realIndex < 0 || realIndex >= values.length) {
            return null;
        }
        return displacements[realIndex][drawableIndex];
    };

    const clamped = Math.max(extended[0], Math.min(extended[extended.length - 1], value));
    let upperIndex = 1;
    while (upperIndex < extended.length && extended[upperIndex] < clamped) {
        upperIndex += 1;
    }
    const lowerValue = extended[upperIndex - 1];
    const upperValue = extended[upperIndex];
    const span = upperValue - lowerValue;
    const t = span > 1e-9 ? (clamped - lowerValue) / span : 0;

    const lower = valueAt(upperIndex - 1);
    const upper = valueAt(upperIndex);
    if (lower !== null && upper !== null) {
        output[drawableIndex] += lower + (upper - lower) * t;
    } else if (lower !== null) {
        output[drawableIndex] += lower * (1 - t);
    } else if (upper !== null) {
        output[drawableIndex] += upper * t;
    }
};

export type DepthEvaluator = {
    /** Fills per-drawable interpolated median depth. */
    evaluate: (assignment: ParamAssignment, output: Float32Array) => void;
};

export const createDepthEvaluator = (
    drawableCount: number,
    neutralDepths: ArrayLike<number>,
    families: Record<string, ScalarFamilyKeyforms>,
): DepthEvaluator => {
    const familyIds = Object.keys(families);
    const scratch = new Float32Array(drawableCount);
    return {
        evaluate: (assignment, output) => {
            for (let index = 0; index < drawableCount; index += 1) {
                output[index] = neutralDepths[index];
                scratch[index] = 0;
            }
            familyIds.forEach((familyId) => {
                const keyforms = families[familyId];
                const value = assignment[familyId as FaceParamId] ?? keyforms.default;
                for (let index = 0; index < drawableCount; index += 1) {
                    lerpScalarInto(keyforms, value, index, scratch);
                }
            });
            for (let index = 0; index < drawableCount; index += 1) {
                output[index] += scratch[index];
            }
        },
    };
};
