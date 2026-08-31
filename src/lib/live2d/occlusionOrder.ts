/**
 * Occlusion-aware per-pose draw orders.
 *
 * Frozen draw orders cannot express occlusion that changes with the pose
 * (back hair sliding behind the jaw, twin-tails crossing), while median-depth
 * re-ranking is too coarse: it compares whole-mesh medians, so recessed
 * overlays (eyes in sockets) wrongly lose to the face skin. The signal that
 * actually decides occlusion is LOCAL: where two drawables' projections
 * overlap, which one's surface is nearer THERE.
 *
 * This module rasterizes each drawable's baked per-vertex depth into a coarse
 * grid per pose sample, compares depths inside overlap regions, and derives a
 * pairwise order graph. Pairs without decisive local evidence keep the
 * neutral stacking.
 */
import type { BakeSample } from './types';

export type OcclusionDrawable = {
    id: string;
    meshId: string;
    vertexCount: number;
    triangles: Uint32Array;
    meshVertexIndices: Uint32Array;
};

export type PoseOrderTable = {
    family: string;
    /** Sorted pose values (from the sweep). */
    values: number[];
    /** orders[k] = drawable indices far-to-near at values[k]. */
    orders: number[][];
};

const GRID = 128;
const MIN_SHARED_CELLS = 4;
const DECISIVE_RATIO = 0.7;

type DepthField = {
    depth: Float32Array;
    covered: Uint8Array;
};

const splatDepth = (
    drawable: OcclusionDrawable,
    sample: BakeSample,
    viewport: { width: number; height: number },
): DepthField | null => {
    const mesh = sample.meshes.find((candidate) => candidate.meshId === drawable.meshId);
    if (!mesh) {
        return null;
    }
    const depth = new Float32Array(GRID * GRID);
    const covered = new Uint8Array(GRID * GRID);
    for (let v = 0; v < drawable.vertexCount; v += 1) {
        const meshVertex = drawable.meshVertexIndices[v];
        const x = mesh.vertices.screenX[meshVertex];
        const y = mesh.vertices.screenY[meshVertex];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            continue;
        }
        const gx = Math.min(GRID - 1, Math.max(0, Math.floor((x / viewport.width) * GRID)));
        const gy = Math.min(GRID - 1, Math.max(0, Math.floor((y / viewport.height) * GRID)));
        const cell = gy * GRID + gx;
        const d = mesh.vertices.depth[meshVertex];
        if (!covered[cell] || d < depth[cell]) {
            depth[cell] = d;
            covered[cell] = 1;
        }
    }
    return { depth, covered };
};

const orderForSample = (
    drawables: OcclusionDrawable[],
    sample: BakeSample,
    neutralRanks: number[],
    viewport: { width: number; height: number },
    dynamicFlags: boolean[] = [],
): number[] => {
    const fields: (DepthField | null)[] = drawables.map((drawable) =>
        splatDepth(drawable, sample, viewport),
    );

    // Hair pieces sort among THEMSELVES by local occlusion evidence, then
    // re-enter the neutral sequence in the same rank slots they already
    // occupy. A full-graph re-sort lets a hair-hair constraint cascade a
    // strand across a non-hair boundary (back hair hopping over the face at
    // pitch), which buried the whole head.
    const hairIndices = drawables
        .map((_d, i) => i)
        .filter((i) => dynamicFlags[i])
        .sort((x, y) => neutralRanks[x] - neutralRanks[y]);
    const beforeHair: boolean[][] = Array.from(
        { length: hairIndices.length },
        () => new Array<boolean>(hairIndices.length).fill(false),
    );
    for (let x = 0; x < hairIndices.length; x += 1) {
        const fieldA = fields[hairIndices[x]];
        if (!fieldA) continue;
        for (let y = x + 1; y < hairIndices.length; y += 1) {
            const fieldB = fields[hairIndices[y]];
            if (!fieldB) continue;
            let xNearer = 0;
            let yNearer = 0;
            for (let cell = 0; cell < GRID * GRID; cell += 1) {
                if (!fieldA.covered[cell] || !fieldB.covered[cell]) continue;
                if (fieldA.depth[cell] < fieldB.depth[cell]) xNearer += 1;
                else yNearer += 1;
            }
            const shared = xNearer + yNearer;
            if (shared < MIN_SHARED_CELLS) continue;
            const yWins = yNearer / shared >= DECISIVE_RATIO;
            const xFirst = yWins ? false : true; // x wins or tie: neutral first
            beforeHair[x][y] = xFirst;
            beforeHair[y][x] = !xFirst;
        }
    }
    const hairOrder: number[] = [];
    const remainingHair = new Set(hairIndices);
    while (remainingHair.size > 0) {
        let picked = -1;
        for (let x = 0; x < hairIndices.length; x += 1) {
            const candidate = hairIndices[x];
            if (!remainingHair.has(candidate)) continue;
            let blocked = false;
            for (let y = 0; y < hairIndices.length; y += 1) {
                if (y === x) continue;
                if (remainingHair.has(hairIndices[y]) && beforeHair[y][x]) {
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
            picked = hairIndices.find((c) => remainingHair.has(c))!;
        }
        remainingHair.delete(picked);
        hairOrder.push(picked);
    }
    const ordered: number[] = [];
    let hairCursor = 0;
    // Walk the NEUTRAL RANK sequence (not index order — drawable indices are
    // unrelated to render order), re-emitting hair slots from the
    // occlusion-sorted hair sequence. Non-hair drawables keep their exact
    // neutral relative order in every pose cell.
    const neutralOrder = drawables
        .map((_d, i) => i)
        .sort((x, y) => neutralRanks[x] - neutralRanks[y]);
    neutralOrder.forEach((drawableIndex) => {
        if (dynamicFlags[drawableIndex]) {
            ordered.push(hairOrder[hairCursor]);
            hairCursor += 1;
        } else {
            ordered.push(drawableIndex);
        }
    });
    return ordered;
};

/**
 * Per-family pose order tables from the bake's sweep samples. Each sweep
 * sample yields one order permutation; values carry the sweep's parameter
 * values sorted ascending.
 */
export const computePoseDrawOrders = (
    drawables: OcclusionDrawable[],
    neutralOrder: number[],
    sweeps: Array<{ family: string; sample: BakeSample }>,
    viewport: { width: number; height: number },
    dynamicFlags: boolean[] = [],
): PoseOrderTable[] => {
    // The verified neutral render order is the base every pose cell merges
    // against — recomputing it from the neutral sample would re-derive it
    // in drawable-index order (indices carry no render-order meaning) and
    // scramble every cell.
    const neutralRanks = new Array<number>(drawables.length).fill(0);
    neutralOrder.forEach((drawable, rank) => {
        neutralRanks[drawable] = rank;
    });
    const byFamily = new Map<string, Array<{ value: number; sample: BakeSample }>>();
    sweeps.forEach(({ family, sample }) => {
        const value = sample.assignment[family as keyof typeof sample.assignment];
        if (typeof value !== 'number') {
            return;
        }
        const bucket = byFamily.get(family) ?? [];
        bucket.push({ value, sample });
        byFamily.set(family, bucket);
    });
    const tables: PoseOrderTable[] = [];
    byFamily.forEach((bucket, family) => {
        bucket.sort((left, right) => left.value - right.value);
        tables.push({
            family,
            values: bucket.map((entry) => entry.value),
            orders: bucket.map((entry) => orderForSample(drawables, entry.sample, neutralRanks, viewport, dynamicFlags)),
        });
    });
    return tables;
};

/** orders[k] lists drawables far-to-near; invert to a rank lookup. */
export const rankOf = (order: number[]): number[] => {
    const ranks = new Array<number>(order.length).fill(0);
    order.forEach((drawable, rank) => {
        ranks[drawable] = rank;
    });
    return ranks;
};

/** The pose key nearest to the driven value. */
export const nearestKey = (values: number[], value: number): number => {
    let best = values[0] ?? 0;
    let bestDelta = Math.abs(value - best);
    values.forEach((candidate) => {
        const delta = Math.abs(value - candidate);
        if (delta < bestDelta) {
            best = candidate;
            bestDelta = delta;
        }
    });
    return best;
};
