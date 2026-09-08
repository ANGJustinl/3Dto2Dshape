import type { DrawableDecomposition } from './decomposition';

/** Split independent hair islands without cutting triangles or shared roots.
 * UVs and textures remain derived from the same neutral projection. */
export const splitHairLayers = (drawable: DrawableDecomposition): DrawableDecomposition[] => {
    if (!/髪|髮|头发|hair|bang|fringe/i.test(drawable.label)) return [drawable];
    const parents = Array.from({ length: drawable.vertexCount }, (_, i) => i);
    const root = (vertex: number): number => {
        while (parents[vertex] !== vertex) {
            parents[vertex] = parents[parents[vertex]];
            vertex = parents[vertex];
        }
        return vertex;
    };
    for (let t = 0; t < drawable.triangles.length; t += 3) {
        const a = root(drawable.triangles[t]);
        parents[root(drawable.triangles[t + 1])] = a;
        parents[root(drawable.triangles[t + 2])] = a;
    }
    const islands = new Map<number, number[]>();
    for (let t = 0; t < drawable.triangles.length; t += 3) {
        const key = root(drawable.triangles[t]);
        const triangles = islands.get(key) ?? [];
        triangles.push(...drawable.triangles.subarray(t, t + 3));
        islands.set(key, triangles);
    }
    // Highly fragmented/import-seam topology is ambiguous; retain one layer.
    if (islands.size < 2 || islands.size > 8 || [...islands.values()].some((v) => v.length < 12)) return [drawable];
    return [...islands.values()].map((source, island) => {
        const local = new Map<number, number>();
        const indices: number[] = [];
        const triangles = source.map((vertex) => {
            if (!local.has(vertex)) {
                local.set(vertex, indices.length);
                indices.push(drawable.meshVertexIndices[vertex]);
            }
            return local.get(vertex)!;
        });
        return {
            ...drawable, id: `${drawable.id}-strand-${island}`,
            label: `${drawable.label} [strand ${island + 1}]`,
            triangles: Uint32Array.from(triangles), meshVertexIndices: Uint32Array.from(indices),
            vertexCount: indices.length, triangleCount: triangles.length / 3,
        };
    });
};
