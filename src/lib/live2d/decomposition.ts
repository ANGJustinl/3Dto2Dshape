import type { BakeBundle, BakeSample } from './types';

/**
 * M1: pose-invariant drawable decomposition.
 *
 * Color-region leaves from splitModelParts are merged by (mesh, material).
 * Material identity is a property of the static mesh, so the grouping cannot
 * change across the parameter space — the precondition for stable keyform
 * identity. Each drawable keeps a compacted vertex table (mesh vertex indices
 * deduplicated) plus the full triangle list remapped into that table.
 */

export type DrawableDecomposition = {
    id: string;
    label: string;
    meshId: string;
    leafIds: string[];
    triangleCount: number;
    /** Original mesh vertex indices, deduplicated and ordered by first use. */
    meshVertexIndices: Uint32Array;
    /** Triangles as indices into meshVertexIndices. */
    triangles: Uint32Array;
    vertexCount: number;
};

const slugify = (value: string) =>
    value
        .normalize('NFKC')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'drawable';

export const decomposeDrawables = (bundle: BakeBundle): DrawableDecomposition[] => {
    const groups = new Map<string, {
        label: string;
        meshId: string;
        leafIds: string[];
        triangles: Array<[number, number, number]>;
    }>();

    bundle.parts.forEach((part) => {
        const key = `${part.meshId}|${part.label}`;
        const group = groups.get(key) ?? {
            label: part.label,
            meshId: part.meshId,
            leafIds: [],
            triangles: [],
        };
        group.leafIds.push(part.leafId);
        part.triangles.forEach((triangle) => {
            group.triangles.push(triangle);
        });
        groups.set(key, group);
    });

    const drawables: DrawableDecomposition[] = [];
    [...groups.entries()]
        .sort(([, left], [, right]) => right.triangles.length - left.triangles.length)
        .forEach(([key, group], groupIndex) => {
            const vertexIndexMap = new Map<number, number>();
            const meshVertexIndices: number[] = [];
            const remappedTriangles = new Uint32Array(group.triangles.length * 3);

            group.triangles.forEach((triangle, triangleIndex) => {
                triangle.forEach((meshVertexIndex, corner) => {
                    let compactIndex = vertexIndexMap.get(meshVertexIndex);
                    if (compactIndex === undefined) {
                        compactIndex = meshVertexIndices.length;
                        vertexIndexMap.set(meshVertexIndex, compactIndex);
                        meshVertexIndices.push(meshVertexIndex);
                    }
                    remappedTriangles[triangleIndex * 3 + corner] = compactIndex;
                });
            });

            drawables.push({
                id: `${slugify(group.label)}-${groupIndex}`,
                label: group.label,
                meshId: group.meshId,
                leafIds: group.leafIds,
                triangleCount: group.triangles.length,
                meshVertexIndices: new Uint32Array(meshVertexIndices),
                triangles: remappedTriangles,
                vertexCount: meshVertexIndices.length,
            });
            void key;
        });

    return drawables;
};

/** Neutral-sample screen positions for a drawable, compacted to its vertex table. */
export const drawableNeutralPositions = (
    drawable: DrawableDecomposition,
    neutral: BakeSample,
): Float32Array => {
    const meshVertices = neutral.meshes.find((mesh) => mesh.meshId === drawable.meshId)?.vertices;
    const positions = new Float32Array(drawable.vertexCount * 2);
    if (!meshVertices) {
        return positions;
    }
    for (let index = 0; index < drawable.meshVertexIndices.length; index += 1) {
        const meshVertexIndex = drawable.meshVertexIndices[index];
        positions[index * 2] = meshVertices.screenX[meshVertexIndex];
        positions[index * 2 + 1] = meshVertices.screenY[meshVertexIndex];
    }
    return positions;
};

/** Neutral-sample NDC depth per drawable vertex (for draw ordering). */
export const drawableNeutralDepths = (
    drawable: DrawableDecomposition,
    neutral: BakeSample,
): Float32Array => {
    const meshVertices = neutral.meshes.find((mesh) => mesh.meshId === drawable.meshId)?.vertices;
    const depths = new Float32Array(drawable.vertexCount);
    if (!meshVertices) {
        return depths;
    }
    for (let index = 0; index < drawable.meshVertexIndices.length; index += 1) {
        depths[index] = meshVertices.depth[drawable.meshVertexIndices[index]];
    }
    return depths;
};

export const drawableBoundsAtNeutral = (
    drawable: DrawableDecomposition,
    neutral: BakeSample,
): { minX: number; minY: number; maxX: number; maxY: number } => {
    const positions = drawableNeutralPositions(drawable, neutral);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < drawable.vertexCount; index += 1) {
        minX = Math.min(minX, positions[index * 2]);
        maxX = Math.max(maxX, positions[index * 2]);
        minY = Math.min(minY, positions[index * 2 + 1]);
        maxY = Math.max(maxY, positions[index * 2 + 1]);
    }
    if (!Number.isFinite(minX)) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    return { minX, minY, maxX, maxY };
};
