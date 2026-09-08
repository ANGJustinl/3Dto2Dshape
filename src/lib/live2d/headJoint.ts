import { drawableNeutralPositions, type DrawableDecomposition } from './decomposition';
import { createPoseEvaluator, drawableDisplacementOffsets, type FamilyKeyforms, type JointKeyforms } from './keyforms';
import type { BakeBundle } from './types';

/** Capture the missing joint head translation without reintroducing facial shear. */
export const buildHeadJointKeyforms = (
    bundle: BakeBundle,
    drawables: DrawableDecomposition[],
    neutralPositions: Float32Array[],
    rawFamilies: Record<string, FamilyKeyforms>,
): JointKeyforms[] => {
    const yaw = bundle.params.find((param) => param.id === 'ParamAngleX');
    const pitch = bundle.params.find((param) => param.id === 'ParamAngleY');
    const faceIndex = drawables.map((drawable, index) => ({ drawable, index }))
        .filter(({ drawable }) => drawable.vertexCount > 0 && /顔|颜|face/i.test(drawable.label) && !/hair|髪|发/i.test(drawable.label))
        .sort((a, b) => b.drawable.vertexCount - a.drawable.vertexCount)[0]?.index ?? -1;
    const corners = bundle.samples.filter((sample) => sample.kind === 'head-corner');
    if (!yaw || !pitch || faceIndex < 0 || corners.length !== 4 ||
        !(yaw.min < yaw.default && yaw.default < yaw.max && pitch.min < pitch.default && pitch.default < pitch.max)) return [];
    const offsets = drawableDisplacementOffsets(drawables);
    const length = neutralPositions.reduce((sum, positions) => sum + positions.length, 0);
    const grid: JointKeyforms = {
        x: { family: yaw.id, default: yaw.default, values: [yaw.min, yaw.default, yaw.max] },
        y: { family: pitch.id, default: pitch.default, values: [pitch.min, pitch.default, pitch.max] },
        displacements: Array.from({ length: 9 }, () => new Float32Array(length)),
    };
    const outputs = neutralPositions.map((positions) => new Float32Array(positions.length));
    const evaluator = createPoseEvaluator(drawables, neutralPositions, rawFamilies);
    const face = neutralPositions[faceIndex];
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < face.length; i += 2) {
        minY = Math.min(minY, face[i]);
        maxY = Math.max(maxY, face[i]);
    }
    const limit = Math.max(1, maxY - minY) * 0.08;
    for (const corner of corners) {
        const xIndex = grid.x.values.indexOf(corner.assignment.ParamAngleX);
        const yIndex = grid.y.values.indexOf(corner.assignment.ParamAngleY);
        if (xIndex < 0 || yIndex < 0) continue;
        evaluator.evaluate(corner.assignment, outputs);
        const observed = drawableNeutralPositions(drawables[faceIndex], corner);
        let dx = 0;
        let dy = 0;
        for (let i = 0; i < observed.length; i += 2) {
            dx += observed[i] - outputs[faceIndex][i];
            dy += observed[i + 1] - outputs[faceIndex][i + 1];
        }
        dx /= observed.length / 2;
        dy /= observed.length / 2;
        const attenuation = Math.min(1, limit / Math.max(1e-6, Math.hypot(dx, dy)));
        dx *= attenuation;
        dy *= attenuation;
        const block = grid.displacements[yIndex * 3 + xIndex];
        drawables.forEach((drawable, index) => {
            if (index !== faceIndex && !/髪|发|髮|hair|bang|fringe|颜|顔|睫|目|眼|瞳|眉|口|唇|齿|歯|舌|二重|头饰|頭飾|eye|lash|brow|mouth|lip|teeth|tongue|headdress/i.test(drawable.label)) return;
            const positions = neutralPositions[index];
            for (let i = 0; i < positions.length; i += 2) {
                // Head and roots share one correction; long tips fade out.
                const weight = 1 - Math.max(0, Math.min(1, (positions[i + 1] - maxY) / Math.max(1, maxY - minY)));
                block[offsets[index] + i] = dx * weight;
                block[offsets[index] + i + 1] = dy * weight;
            }
        });
    }
    return [grid];
};
