import type { DrawableDecomposition } from './decomposition';
import { createPoseEvaluator, drawableDisplacementOffsets, type FamilyKeyforms, type JointKeyforms } from './keyforms';
import { defaultAssignment } from './paramMapping';

/** MouthForm and MouthOpenY are independent controls (Cubism standard parameters).
 * Author six joint poses, not an amplified additive smile morph. All mouth
 * surfaces and the face aperture use the same continuous screen-space warp.
 * The warp itself is our approximation, not an algorithm from the manuals.
 * https://docs.live2d.com/en/cubism-editor-manual/standard-parameter-list/
 */
export function buildMouthRig(
    drawables: DrawableDecomposition[], neutral: Float32Array[],
    source: Record<string, FamilyKeyforms>,
): { families: Record<string, FamilyKeyforms>; joints: JointKeyforms[] } {
    const lipIndex = drawables.findIndex(d => /^(口线|口線|唇|lip|mouth[ _-]?line)(?:-|$)/i.test(d.label));
    if (lipIndex < 0 || !source.ParamMouthForm || !source.ParamMouthOpenY) {
        return { families: source, joints: [] };
    }
    const lip = neutral[lipIndex];
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < lip.length; i += 2) {
        minX = Math.min(minX, lip[i]); maxX = Math.max(maxX, lip[i]);
    }
    const halfWidth = (maxX - minX) / 2;
    if (!Number.isFinite(halfWidth) || halfWidth < 0.01) return { families: source, joints: [] };
    const offsets = drawableDisplacementOffsets(drawables);
    const length = neutral.reduce((sum, p) => sum + p.length, 0);
    // Do not retain smile displacements on hidden facial surfaces or eyes.
    const families = { ...source, ParamMouthForm: {
        ...source.ParamMouthForm,
        displacements: source.ParamMouthForm.displacements.map(() => new Float32Array(length)),
    } };
    const joint: JointKeyforms = {
        x: { family: 'ParamMouthForm', default: 0, values: [0, 1] },
        y: { family: 'ParamMouthOpenY', default: 0, values: [0, 0.5, 1] },
        displacements: Array.from({ length: 6 }, () => new Float32Array(length)),
    };
    const evaluator = createPoseEvaluator(drawables, neutral, families);
    const output = neutral.map(p => new Float32Array(p.length));
    joint.y.values.forEach((open, row) => {
        evaluator.evaluate({ ...defaultAssignment(), ParamMouthOpenY: open }, output);
        const points = output[lipIndex];
        let lowY = Infinity, highY = -Infinity;
        for (let i = 1; i < points.length; i += 2) {
            lowY = Math.min(lowY, points[i]); highY = Math.max(highY, points[i]);
        }
        const centerX = (minX + maxX) / 2, centerY = (lowY + highY) / 2;
        const radiusY = Math.max(halfWidth * 0.75, (highY - lowY) / 2 + halfWidth * 0.45);
        const block = joint.displacements[row * 2 + 1];
        drawables.forEach((d, index) => {
            if (d.meshId !== drawables[lipIndex].meshId ||
                !/^(顔|颜|face|口|唇|齿|歯|牙|舌|lip|mouth|teeth|tooth|tongue)/i.test(d.label)) return;
            for (let i = 0; i < output[index].length; i += 2) {
                const dx = output[index][i] - centerX, dy = output[index][i + 1] - centerY;
                const nx = Math.abs(dx) / halfWidth, ny = Math.abs(dy) / radiusY;
                // Flat interior, smooth compact boundary. Same XY => same warp,
                // including face-mask vertices, preventing smile-induced gaps.
                const fade = (v: number) => { const t = Math.max(0, Math.min(1, v)); return 1 - t * t * (3 - 2 * t); };
                const weight = fade((nx - 1) / 0.8) * fade((ny - 0.55) / 0.45);
                block[offsets[index] + i] = dx * 0.16 * weight;
                // Screen Y points down: lift corners, gently soften an open jaw.
                block[offsets[index] + i + 1] = (-halfWidth * 0.22 * Math.min(1, nx * nx) - dy * open * 0.08) * weight;
            }
        });
    });
    return { families, joints: [joint] };
}
