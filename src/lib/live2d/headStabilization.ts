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
    a: number;
    b: number;
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
    allowRotation = false,
): CentroidTransform => {
    const sourceCentroid = centroidOf(source);
    const targetCentroid = centroidOf(target);
    let sourceRadius = 0;
    let targetRadius = 0;
    let dot = 0, cross = 0;
    for (let index = 0; index < source.length; index += 2) {
        const sourceX = source[index] - sourceCentroid.x;
        const sourceY = source[index + 1] - sourceCentroid.y;
        const targetX = target[index] - targetCentroid.x;
        const targetY = target[index + 1] - targetCentroid.y;
        sourceRadius += sourceX * sourceX + sourceY * sourceY;
        targetRadius += targetX * targetX + targetY * targetY;
        dot += sourceX * targetX + sourceY * targetY;
        cross += sourceX * targetY - sourceY * targetX;
    }
    const rawScale = sourceRadius > 1e-9 ? Math.sqrt(targetRadius / sourceRadius) : 1;
    const angle = allowRotation ? Math.atan2(cross, dot) : 0;
    const scale = allowScale ? Math.max(0.97, Math.min(1.03, rawScale)) : 1;
    return {
        sourceX: sourceCentroid.x,
        sourceY: sourceCentroid.y,
        targetX: targetCentroid.x,
        targetY: targetCentroid.y,
        // Preserve the subtle silhouette compression of yaw, but pitch is a
        // rigid 2D head motion so it cannot stretch or squash the face.
        a: scale * Math.cos(angle),
        b: scale * Math.sin(angle),
    };
};

const transformedPoint = (transform: CentroidTransform, x: number, y: number) => ({
    x: transform.targetX + (x - transform.sourceX) * transform.a - (y - transform.sourceY) * transform.b,
    y: transform.targetY + (x - transform.sourceX) * transform.b + (y - transform.sourceY) * transform.a,
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
    if (drawable.facialRole || drawable.maskOnly) return true;
    if (HAIR_PATTERN.test(drawable.label) || HEAD_ACCESSORY_PATTERN.test(drawable.label)) {
        return false;
    }
    if (FACE_FEATURE_PATTERN.test(drawable.label)) {
        return true;
    }
    const centroid = centroidOf(positions);
    const bounds = boundsOf(positions);
    const width = Math.max(1, faceBounds.maxX - faceBounds.minX);
    const height = Math.max(1, faceBounds.maxY - faceBounds.minY);
    return (
        bounds.maxX - bounds.minX <= width * 1.2 &&
        bounds.maxY - bounds.minY <= height * 1.2 &&
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
    residualWeightAt: (x: number, y: number, vertex: number) => number,
) => {
    for (let local = 0; local < neutral.length; local += 2) {
        const neutralX = neutral[local];
        const neutralY = neutral[local + 1];
        const rigid = transformedPoint(transform, neutralX, neutralY);
        const rawX = neutralX + (raw[packedOffset + local] ?? 0);
        const rawY = neutralY + (raw[packedOffset + local + 1] ?? 0);
        const residualWeight = residualWeightAt(neutralX, neutralY, local / 2);
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
        .filter(({ drawable }) => drawable.vertexCount > 0 && (drawable.facialRole === 'skin' || (!drawable.facialRole && FACE_ANCHOR_PATTERN.test(drawable.label) && !HAIR_PATTERN.test(drawable.label))))
        .sort((a,b)=>Number(b.drawable.facialRole==='skin')-Number(a.drawable.facialRole==='skin')||b.drawable.vertexCount-a.drawable.vertexCount)[0]?.index;
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
            if (familyId !== 'ParamAngleX' && familyId !== 'ParamAngleY' && familyId !== 'ParamAngleZ') {
                return [familyId, family];
            }
            const isYaw = familyId === 'ParamAngleX';
            const isRoll = familyId === 'ParamAngleZ';
            // Share the same canonical grid with native Cubism. Intermediate
            // head and expression transforms interpolate one matrix together.
            const indices=[...new Set([0,family.values.indexOf(family.default),family.values.length-1])].filter(i=>i>=0).sort((a,b)=>a-b);
            const transforms=indices.map(i=>({value:family.values[i],transform:fitCentroidTransform(faceNeutral,targetPositions(faceNeutral,family.displacements[i],offsets[faceIndex]),isYaw,isRoll)}));
            const transformAt=(value:number):CentroidTransform=>{
                if(transforms.length===1)return transforms[0].transform;
                let hi=1;while(hi<transforms.length-1&&transforms[hi].value<value)hi++;
                const lo=hi-1,t=Math.max(0,Math.min(1,(value-transforms[lo].value)/(transforms[hi].value-transforms[lo].value)));
                const a=transforms[lo].transform,b=transforms[hi].transform;
                return{sourceX:a.sourceX,sourceY:a.sourceY,targetX:a.targetX+(b.targetX-a.targetX)*t,targetY:a.targetY+(b.targetY-a.targetY)*t,a:a.a+(b.a-a.a)*t,b:a.b+(b.b-a.b)*t};
            };
            return [
                familyId,
                {
                    ...family,
                    values: [...family.values],
                    displacements: family.displacements.map((raw,key) => {
                        const output = new Float32Array(raw);
                        const transform = transformAt(family.values[key]);

                        drawables.forEach((drawable, drawableIndex) => {
                            const neutral = neutralPositions[drawableIndex];
                            const offset = offsets[drawableIndex];
                            const isFace = drawableIndex === faceIndex;
                            const isFrontHair = FRONT_HAIR_PATTERN.test(drawable.label);
                            const isHair = HAIR_PATTERN.test(drawable.label);
                            const isAccessory = HEAD_ACCESSORY_PATTERN.test(drawable.label);
                            const isFeature = isFeatureInsideFace(drawable, neutral, faceBounds);
                            if(isRoll){
                                if(drawable.rollAttachment)writeStabilizedDrawable(output,raw,offset,neutral,transform,(_x,_y,v)=>1-drawable.rollAttachment![v]);
                                else if(isFace||isFeature)writeStabilizedDrawable(output,raw,offset,neutral,transform,()=>0);
                                return;
                            }
                            const attachment=drawable.headAttachment??drawable.rollAttachment;
                            if(attachment){
                                writeStabilizedDrawable(output,raw,offset,neutral,transform,(_x,_y,v)=>1-attachment[v]);
                                return;
                            }

                            if (isFace) {
                                // The baked texture is a front projection, not a UV skin.
                                // Rotating its rear surface through the visible face folds
                                // the same pixels over eyes and mouth. Keep one shared 2D rig.
                                writeStabilizedDrawable(output, raw, offset, neutral, transform, () => 0);
                                return;
                            }
                            if (isFrontHair || isFeature) {
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
