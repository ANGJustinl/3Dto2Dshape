import type { DrawableDecomposition } from './decomposition';
import type { BakeBundle, BakeSample } from './types';

/**
 * M3: draw ordering. Painter's algorithm back-to-front by median NDC depth at
 * the neutral sample (NDC z grows with distance). The consistency check walks
 * every baked sample and reports depth-order flips against the neutral order,
 * which is exactly where occlusion crossovers will appear at runtime.
 */

export const medianDepth = (drawable: DrawableDecomposition, sample: BakeSample): number => {
    const meshVertices = sample.meshes.find((mesh) => mesh.meshId === drawable.meshId)?.vertices;
    if (!meshVertices) {
        return Number.NEGATIVE_INFINITY;
    }
    const depths = new Float64Array(drawable.vertexCount);
    for (let index = 0; index < drawable.vertexCount; index += 1) {
        depths[index] = meshVertices.depth[drawable.meshVertexIndices[index]];
    }
    depths.sort();
    const middle = Math.floor(drawable.vertexCount / 2);
    return drawable.vertexCount % 2 === 0
        ? (depths[middle - 1] + depths[middle]) / 2
        : depths[middle];
};

/** Drawable ids ordered far-to-near. */
export const computeDrawOrder = (
    drawables: DrawableDecomposition[],
    neutral: BakeSample,
): string[] =>
    drawables
        .map((drawable) => ({ id: drawable.id, depth: medianDepth(drawable, neutral) }))
        .sort((left, right) => right.depth - left.depth)
        .map((entry) => entry.id);

export type OrderFlip = {
    sampleId: string;
    family: string | null;
    outer: string;
    inner: string;
};

/**
 * For every sample, check each pair of adjacent drawables (in neutral order)
 * for depth inversion. A flip means the nearer drawable at neutral became the
 * farther one at that pose — the classic Live2D occlusion break point.
 */
export const checkOrderConsistency = (
    bundle: BakeBundle,
    drawables: DrawableDecomposition[],
    orderIds: string[],
): { flips: OrderFlip[]; samplesChecked: number } => {
    const drawableById = new Map(drawables.map((drawable) => [drawable.id, drawable]));
    const flips: OrderFlip[] = [];
    let samplesChecked = 0;

    bundle.samples.forEach((sample) => {
        if (sample.kind === 'neutral') {
            return;
        }
        samplesChecked += 1;
        const depths = new Map(
            orderIds.map((id) => {
                const drawable = drawableById.get(id);
                return [id, drawable ? medianDepth(drawable, sample) : Number.NEGATIVE_INFINITY];
            }),
        );
        for (let index = 0; index < orderIds.length - 1; index += 1) {
            const outer = orderIds[index];
            const inner = orderIds[index + 1];
            if ((depths.get(outer) ?? 0) < (depths.get(inner) ?? 0)) {
                flips.push({
                    sampleId: sample.id,
                    family: sample.family ?? null,
                    outer,
                    inner,
                });
            }
        }
    });

    return { flips, samplesChecked };
};
