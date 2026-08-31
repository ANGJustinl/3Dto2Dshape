import type { DrawableDecomposition } from './decomposition';
import { drawableDisplacementOffsets, type FamilyKeyforms } from './keyforms';

const FACE_ANCHOR_PATTERN = /顔|颜|face/i;
const FACE_FEATURE_PATTERN =
    /睫|目|眼|瞳|眉|口|唇|齿|歯|牙|舌|鼻|二重|eye|iris|pupil|lash|brow|mouth|lip|teeth|tooth|tongue|nose/i;
const HAIR_PATTERN = /髪|发|髮|hair|bang|fringe/i;
const FRONT_HAIR_PATTERN = /前髪|前发|前髮|bang|fringe/i;
const HEAD_ACCESSORY_PATTERN = /头饰|頭飾|髪飾|发饰|髮飾|headdress|hair.?accessory/i;

type Bounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

type CentroidTransform = {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    scale: number;
};

const boundsOf = (positions: Float32Array): Bounds => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < positions.length; index += 2) {
        minX = Math.min(minX, positions[index]);
        minY = Math.min(minY, positions[index + 1]);
        maxX = Math.max(maxX, positions[index]);
        maxY = Math.max(maxY, positions[index + 1]);
    }
    return { minX, minY, maxX, maxY };
};

const centroidOf = (positions: Float32Array) => {
    let x = 0;
    let y = 0;
    const count = positions.length / 2;
    for (let index = 0; index < positions.length; index += 2) {
        x += positions[index];
        y += positions[index + 1];
    }
    return {
        x: count > 0 ? x / count : 0,
        y: count > 0 ? y / count : 0,
    };
};

const targetPositions = (
    neutral: Float32Array,
    displacement: Float32Array,
    packedOffset: number,
) => {
    const target = new Float32Array(neutral.length);
    for (let index = 0; index < neutral.length; index += 1) {
        target[index] = neutral[index] + (displacement[packedOffset + index] ?? 0);
    }
    return target;
};

/**
 * Fits only shared translation and a tightly clamped uniform scale. Angle X/Y
 * must not inherit an in-plane rotation: ParamAngleZ owns roll, while a 2D
 * rotation inferred from an asymmetric face mesh makes the eyes drift.
 */
const fitCentroidTransform = (
    source: Float32Array,
    target: Float32Array,
    allowScale: boolean,
): CentroidTransform => {
    const sourceCentroid = centroidOf(source);
    const targetCentroid = centroidOf(target);
    let sourceRadius = 0;
    let targetRadius = 0;
    for (let index = 0; index < source.length; index += 2) {
        const sourceX = source[index] - sourceCentroid.x;
        const sourceY = source[index + 1] - sourceCentroid.y;
        const targetX = target[index] - targetCentroid.x;
        const targetY = target[index + 1] - targetCentroid.y;
        sourceRadius += sourceX * sourceX + sourceY * sourceY;
        targetRadius += targetX * targetX + targetY * targetY;
    }
    const rawScale = sourceRadius > 1e-9 ? Math.sqrt(targetRadius / sourceRadius) : 1;
    return {
        sourceX: sourceCentroid.x,
        sourceY: sourceCentroid.y,
        targetX: targetCentroid.x,
        targetY: targetCentroid.y,
        // Preserve the subtle silhouette compression of yaw, but pitch is a
        // rigid 2D head motion so it cannot stretch or squash the face.
        scale: allowScale ? Math.max(0.97, Math.min(1.03, rawScale)) : 1,
    };
};

const transformedPoint = (transform: CentroidTransform, x: number, y: number) => ({
    x: transform.targetX + (x - transform.sourceX) * transform.scale,
    y: transform.targetY + (y - transform.sourceY) * transform.scale,
});

const smoothstep = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped * clamped * (3 - 2 * clamped);
};

const isFeatureInsideFace = (
    drawable: DrawableDecomposition,
    positions: Float32Array,
    faceBounds: Bounds,
) => {
    if (HAIR_PATTERN.test(drawable.label) || HEAD_ACCESSORY_PATTERN.test(drawable.label)) {
        return false;
    }
    if (FACE_FEATURE_PATTERN.test(drawable.label)) {
        return true;
    }
    const centroid = centroidOf(positions);
    const width = Math.max(1, faceBounds.maxX - faceBounds.minX);
    const height = Math.max(1, faceBounds.maxY - faceBounds.minY);
    return (
        centroid.x >= faceBounds.minX - width * 0.08 &&
        centroid.x <= faceBounds.maxX + width * 0.08 &&
        centroid.y >= faceBounds.minY - height * 0.12 &&
        centroid.y <= faceBounds.maxY + height * 0.12
    );
};

const writeStabilizedDrawable = (
    output: Float32Array,
    raw: Float32Array,
    packedOffset: number,
    neutral: Float32Array,
    transform: CentroidTransform,
    residualWeightAt: (x: number, y: number) => number,
) => {
    for (let local = 0; local < neutral.length; local += 2) {
        const neutralX = neutral[local];
        const neutralY = neutral[local + 1];
        const rigid = transformedPoint(transform, neutralX, neutralY);
        const rawX = neutralX + (raw[packedOffset + local] ?? 0);
        const rawY = neutralY + (raw[packedOffset + local + 1] ?? 0);
        const residualWeight = residualWeightAt(neutralX, neutralY);
        const targetX = rigid.x + (rawX - rigid.x) * residualWeight;
        const targetY = rigid.y + (rawY - rigid.y) * residualWeight;
        output[packedOffset + local] = targetX - neutralX;
        output[packedOffset + local + 1] = targetY - neutralY;
    }
};

/**
 * Converts raw 3D projection keyforms into a layered 2D head rig:
 *
 * - front hair follows a stable face transform instead of shearing across an
 *   eye during yaw, while facial features keep the original turn cues;
 * - ParamAngleY makes the face itself rigid, eliminating perspective squash;
 * - hair roots follow the face while lower tips retain a restrained residual.
 *
 * Blink and mouth families are untouched, as are the body and ParamAngleZ.
 */
export const stabilizeHeadAngleKeyforms = (
    drawables: DrawableDecomposition[],
    neutralPositions: Float32Array[],
    families: Record<string, FamilyKeyforms>,
): Record<string, FamilyKeyforms> => {
    const faceIndex = drawables
        .map((drawable, index) => ({ drawable, index }))
        .filter(({ drawable }) => FACE_ANCHOR_PATTERN.test(drawable.label) && !HAIR_PATTERN.test(drawable.label))
        .sort((left, right) => right.drawable.vertexCount - left.drawable.vertexCount)[0]?.index;
    if (faceIndex === undefined) {
        return families;
    }

    const offsets = drawableDisplacementOffsets(drawables);
    const faceNeutral = neutralPositions[faceIndex];
    const faceBounds = boundsOf(faceNeutral);
    const faceHeight = Math.max(1, faceBounds.maxY - faceBounds.minY);
    const hairRigidUntilY = faceBounds.maxY - faceHeight * 0.08;
    const hairFlexibleAtY = faceBounds.maxY + faceHeight * 0.9;

    return Object.fromEntries(
        Object.entries(families).map(([familyId, family]) => {
            if (familyId !== 'ParamAngleX' && familyId !== 'ParamAngleY') {
                return [familyId, family];
            }
            const isYaw = familyId === 'ParamAngleX';
            return [
                familyId,
                {
                    ...family,
                    values: [...family.values],
                    displacements: family.displacements.map((raw) => {
                        const output = new Float32Array(raw);
                        const faceTarget = targetPositions(faceNeutral, raw, offsets[faceIndex]);
                        const transform = fitCentroidTransform(faceNeutral, faceTarget, isYaw);

                        drawables.forEach((drawable, drawableIndex) => {
                            const neutral = neutralPositions[drawableIndex];
                            const offset = offsets[drawableIndex];
                            const isFace = drawableIndex === faceIndex;
                            const isFrontHair = FRONT_HAIR_PATTERN.test(drawable.label);
                            const isHair = HAIR_PATTERN.test(drawable.label);
                            const isAccessory = HEAD_ACCESSORY_PATTERN.test(drawable.label);
                            const isFeature = isFeatureInsideFace(drawable, neutral, faceBounds);

                            if (isFace) {
                                if (!isYaw) {
                                    writeStabilizedDrawable(output, raw, offset, neutral, transform, () => 0);
                                }
                                return;
                            }
                            if (isFrontHair || (!isYaw && isFeature)) {
                                writeStabilizedDrawable(output, raw, offset, neutral, transform, () => 0);
                                return;
                            }
                            if (isAccessory) {
                                if (!isYaw) {
                                    writeStabilizedDrawable(output, raw, offset, neutral, transform, () => 0.15);
                                }
                                return;
                            }
                            if (isHair && !isYaw) {
                                writeStabilizedDrawable(output, raw, offset, neutral, transform, (_x, y) => {
                                    const progress = (y - hairRigidUntilY) / (hairFlexibleAtY - hairRigidUntilY);
                                    return smoothstep(progress) * 0.4;
                                });
                            }
                        });
                        return output;
                    }),
                } satisfies FamilyKeyforms,
            ];
        }),
    );
};
