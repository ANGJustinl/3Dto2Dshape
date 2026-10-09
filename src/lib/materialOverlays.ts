import * as THREE from 'three';

type MaterialGroup = { start: number; count: number; materialIndex: number };
type Triangle = [number, number, number];
type OrderedTriangle = { vertices: Triangle; winding: number };
type SourceTriangle = OrderedTriangle & { side: THREE.Side };
type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

const isAdditiveSphereMap = (material: THREE.Material) => {
    const source = material as THREE.Material & {
        isMMDToonMaterial?: boolean;
        matcap?: THREE.Texture | null;
        matcapCombine?: THREE.Combine;
    };
    return source.isMMDToonMaterial === true && source.matcap != null &&
        source.matcapCombine === THREE.AddOperation;
};

/**
 * Flat paint cannot reproduce an MMD sphere-map shader pass. A duplicated
 * additive pass would become an opaque color and compete with its base surface
 * in the depth buffer. Omit only fully redundant passes, independent of names.
 * Coincidence alone is insufficient: skinning and every position morph must
 * match so separate surfaces that diverge during animation are retained.
 */
export function findRedundantMaterialOverlayGroups(
    geometry: THREE.BufferGeometry,
    materials: THREE.Material[],
    groups: readonly MaterialGroup[],
): Set<number> {
    const omitted = new Set<number>();
    const candidates = groups.map((group, groupIndex) => ({ group, groupIndex }))
        .filter(({ group }) => materials[group.materialIndex] &&
            isAdditiveSphereMap(materials[group.materialIndex]));
    const index = geometry.index;
    const position = geometry.getAttribute('position');
    if (!candidates.length || !index || !position) return omitted;

    const positionKeys = new Map<number, string>();
    const positionKey = (vertex: number) => {
        let key = positionKeys.get(vertex);
        if (key === undefined) {
            // Exact source coordinates keep nearby, intentionally offset shells.
            key = `${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`;
            positionKeys.set(vertex, key);
        }
        return key;
    };
    const triangleAt = (offset: number): OrderedTriangle => {
        const vertices: Triangle = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
        const [first, second] = vertices;
        vertices.sort((a, b) => positionKey(a) < positionKey(b) ? -1 : positionKey(a) > positionKey(b) ? 1 : 0);
        const winding = (vertices.indexOf(second) - vertices.indexOf(first) + 3) % 3 === 1 ? 1 : -1;
        return { vertices, winding };
    };
    const triangleKey = (vertices: Triangle) => vertices.map(positionKey).join(';');
    const baseTriangles = new Map<string, SourceTriangle[]>();
    for (const group of groups) {
        const material = materials[group.materialIndex];
        if (!material || !material.visible || material.opacity < 0.999 || isAdditiveSphereMap(material)) continue;
        for (let offset = group.start; offset + 2 < group.start + group.count; offset += 3) {
            const triangle = triangleAt(offset);
            const key = triangleKey(triangle.vertices);
            const sources = baseTriangles.get(key) ?? [];
            sources.push({ ...triangle, side: material.side });
            baseTriangles.set(key, sources);
        }
    }

    const deformationAttributes: Attribute[] = [
        geometry.getAttribute('skinIndex'), geometry.getAttribute('skinWeight'),
        ...(geometry.morphAttributes.position ?? []),
    ].filter((attribute): attribute is Attribute => attribute != null);
    const componentGetters = ['getX', 'getY', 'getZ', 'getW'] as const;
    const vertexMatches = new Map<string, boolean>();
    const sameDeformation = (a: number, b: number) => {
        if (a === b) return true;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const cached = vertexMatches.get(key);
        if (cached !== undefined) return cached;
        const matches = deformationAttributes.every((attribute) => {
            if (attribute.itemSize > componentGetters.length) return false;
            for (let component = 0; component < attribute.itemSize; component += 1) {
                const getter = componentGetters[component];
                if (attribute[getter](a) !== attribute[getter](b)) return false;
            }
            return true;
        });
        vertexMatches.set(key, matches);
        return matches;
    };

    for (const { group, groupIndex } of candidates) {
        if (group.count === 0 || group.count % 3 !== 0) continue;
        const material = materials[group.materialIndex];
        let fullyCovered = true;
        for (let offset = group.start; offset < group.start + group.count; offset += 3) {
            const { vertices, winding } = triangleAt(offset);
            const sources = baseTriangles.get(triangleKey(vertices));
            if (!sources?.some((source) =>
                (source.side === THREE.DoubleSide ||
                    (source.side === material.side && source.winding === winding)) &&
                vertices.every((vertex, corner) => sameDeformation(vertex, source.vertices[corner])))) {
                fullyCovered = false;
                break;
            }
        }
        if (fullyCovered) omitted.add(groupIndex);
    }
    return omitted;
}
