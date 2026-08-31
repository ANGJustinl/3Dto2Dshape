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

/**
 * Drawables whose label matches participate in pose-driven draw-order
 * reordering: hair (front/back/side). Overlay features (eyes, brows, mouth)
 * keep their PSD stacking — geometric depth for recessed features (eyes in
 * sockets) would wrongly bury them mid-turn.
 */
export const DYNAMIC_DRAWABLE_PATTERN = /髪|Hair|hair/;

/**
 * Per-angle draw-order ranking that only inverts pairs whose relative depth
 * flipped DECISIVELY at the pose.
 *
 * Raw median-depth re-ranking is unstable for meshes that wrap the head
 * (back hair): their median lands near the head center — statistically tied
 * with the face — so head-turn noise flips them over the face. Requiring a
 * decisive margin means side hair (far from the rotation axis, large depth
 * swing) still re-ranks, while statistically tied pairs keep the neutral
 * stacking. Ties/cycles fall back to neutral order.
 *
 * @param neutralOrder drawable indices sorted far-to-near (the rest stack)
 * @param evaluated per-drawable depth at the pose (same units as neutral)
 * @param margin minimum depth difference for a flip to count (e.g. 2% of
 *   the depth span)
 */
export const rankByDepthFlips = (
    neutralOrder: number[],
    evaluated: ArrayLike<number>,
    margin: number,
    dynamic: ArrayLike<boolean> = [],
): number[] => {
    const count = neutralOrder.length;
    const isDynamic = (drawable: number) => dynamic[drawable] ?? false;
    const neutralRankOf = new Array<number>(count);
    neutralOrder.forEach((drawable, rank) => {
        neutralRankOf[drawable] = rank;
    });
    // before[a][b]: a draws before b (a is farther) in this pose's order.
    const before: boolean[][] = Array.from({ length: count }, () => new Array<boolean>(count).fill(false));
    for (let left = 0; left < count; left += 1) {
        for (let right = left + 1; right < count; right += 1) {
            const a = neutralOrder[left];
            const b = neutralOrder[right];
            const depthDelta = evaluated[a] - evaluated[b];
            // Neutral: a draws before b. Invert only when b is now
            // decisively farther than a.
            // Only occlusion-class drawables (hair) reorder: overlay
            // features (eyes, brows, mouth) keep their PSD stacking even
            // when the 3D projection puts them geometrically behind the
            // face skin mid-turn.
            const allowFlip = isDynamic(a) || isDynamic(b);
            const aFirst = !allowFlip || depthDelta >= -margin;
            before[a][b] = aFirst;
            before[b][a] = !aFirst;
        }
    }
    // Kahn's topological sort, neutral rank as the tie-break priority; on a
    // cycle (no available node) force-advance the neutral-earliest remaining
    // drawable so the result always completes.
    const remaining = new Set(neutralOrder);
    const order: number[] = [];
    while (remaining.size > 0) {
        let picked = -1;
        for (const candidate of neutralOrder) {
            if (!remaining.has(candidate)) {
                continue;
            }
            let blocked = false;
            for (const other of remaining) {
                if (other !== candidate && before[other][candidate]) {
                    blocked = true;
                    break;
                }
            }
            if (!blocked) {
                picked = candidate;
                break;
            }
        }
        if (picked < 0) {
            for (const candidate of neutralOrder) {
                if (remaining.has(candidate)) {
                    picked = candidate;
                    break;
                }
            }
        }
        remaining.delete(picked);
        order.push(picked);
    }
    const rankOf = new Array<number>(count);
    order.forEach((drawable, rank) => {
        rankOf[drawable] = rank;
    });
    void neutralRankOf;
    return rankOf;
};
