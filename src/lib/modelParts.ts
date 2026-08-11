import * as THREE from 'three';
import type { PaintLayerKind } from './2DRenderShared/types';

export type PartNode = {
    id: string;
    label: string;
    depth: number;
    triangleCount: number;
    leafIds: string[];
    swatchColor?: string;
    children: PartNode[];
};

type GeometryGroup = {
    start: number;
    count: number;
    materialIndex: number;
};

type TriangleRecord = {
    id: string;
    vertexIndices: [number, number, number];
    vertexPositionKeys: [string, string, string];
    colorRgb: [number, number, number];
    colorLabel: string;
};

type TriangleAdjacencyEdge = {
    leftIndex: number;
    rightIndex: number;
    diff: number;
    bucket: number;
};

type TriangleCluster = {
    id: number;
    triangles: TriangleRecord[];
    centroid: [number, number, number];
};

export type SegmentationResult = {
    parts: PartNode[];
    leafMaterialMap: Map<string, THREE.Material>;
    debugMaterials: MaterialDebugInfo[];
    projectionParts: ProjectionPartSource[];
    projectionSharedChains: ProjectionSharedChain[];
};

export type MeshPartLookup = {
    meshUuid: string;
    leafIdByMaterialIndex: string[];
};

export type MaterialDebugInfo = {
    materialName: string;
    mapPresent: boolean;
    mapKind: string;
    mapFileName: string | null;
    materialColor: string;
    imageWidth: number | null;
    imageHeight: number | null;
    sampleColors: string[];
};

export type ProjectionTriangleSource = {
    vertexIndices: [number, number, number];
    vertexPositionKeys: [string, string, string];
};

export type ProjectionPartSource = {
    leafId: string;
    sourceLeafId?: string;
    paintLayer?: PaintLayerKind;
    mesh: THREE.Mesh | THREE.SkinnedMesh;
    triangleCount: number;
    color: string;
    triangles: ProjectionTriangleSource[];
};

export type ProjectionSharedChain = {
    id: string;
    mesh: THREE.Mesh | THREE.SkinnedMesh;
    leafIds: [string, string];
    vertexIndices: number[];
    vertexPositionKeys: string[];
};

export type TriangleSampleDebugInfo = {
    uv: [number, number] | null;
    materialColor: {
        rgb: [number, number, number];
        hex: string;
    };
    textureColor: {
        rgb: [number, number, number];
        hex: string;
        alpha: number;
    } | null;
    finalColor: {
        rgb: [number, number, number];
        hex: string;
    };
    visibleColorOnBlack: {
        rgb: [number, number, number];
        hex: string;
        alpha: number;
    };
};

const MODEL_MATERIAL_EXCLUSION_KEYWORDS: Record<string, string[]> = {
    Corin: ['髪+'],
};

const COLOR_EDGE_BUCKET_SIZE = 4;
const COLOR_LOCAL_THRESHOLD = 64;
const SMALL_REGION_TRIANGLE_LIMIT = 1;
const SMALL_REGION_MERGE_THRESHOLD = 48;
const TRIANGLE_COLOR_SAMPLE_MODE = 'uv-multi-sample-interior-average';
const POSITION_KEY_EPSILON = 1e-4;
const TRIANGLE_INTERIOR_SAMPLE_BARYCENTRICS: Array<[number, number, number]> = [
    [0.6, 0.2, 0.2],
    [0.2, 0.6, 0.2],
    [0.2, 0.2, 0.6],
    [0.34, 0.33, 0.33],
];
const texturePixelReaderCache = new WeakMap<
    THREE.Texture,
    ((u: number, v: number) => { r: number; g: number; b: number; a: number }) | null
>();

const colorKeyFromRgb = (r: number, g: number, b: number) =>
    [r, g, b]
        .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
        .join('');

const colorLabelFromKey = (key: string) => `#${key.toUpperCase()}`;
const colorLabelFromColor = (color: THREE.Color) =>
    colorLabelFromKey(
        colorKeyFromRgb(
            Math.round(color.r * 255),
            Math.round(color.g * 255),
            Math.round(color.b * 255),
        ),
    );

const getPositionKey = (
    positionAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    vertexIndex: number,
) => {
    const x = Math.round(positionAttribute.getX(vertexIndex) / POSITION_KEY_EPSILON);
    const y = Math.round(positionAttribute.getY(vertexIndex) / POSITION_KEY_EPSILON);
    const z = Math.round(positionAttribute.getZ(vertexIndex) / POSITION_KEY_EPSILON);
    return `${x},${y},${z}`;
};

const colorDistance = (left: [number, number, number], right: [number, number, number]) => {
    const dr = left[0] - right[0];
    const dg = left[1] - right[1];
    const db = left[2] - right[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
};

const averageRgb = (samples: Array<[number, number, number]>): [number, number, number] => {
    if (samples.length === 0) {
        return [255, 255, 255];
    }

    const totals = samples.reduce(
        (accumulator, sample) => [
            accumulator[0] + sample[0],
            accumulator[1] + sample[1],
            accumulator[2] + sample[2],
        ],
        [0, 0, 0] as [number, number, number],
    );

    return [
        Math.round(totals[0] / samples.length),
        Math.round(totals[1] / samples.length),
        Math.round(totals[2] / samples.length),
    ];
};

const rgbToHex = (rgb: [number, number, number]) => colorLabelFromKey(colorKeyFromRgb(...rgb));

const getOrderedEdgeKey = (left: string, right: string) =>
    left < right ? `${left}|${right}` : `${right}|${left}`;

const getTriangleSampleUvs = (
    uvAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    vertexIndices: [number, number, number],
) => {
    const triangleUvs: [[number, number], [number, number], [number, number]] = [
        [uvAttribute.getX(vertexIndices[0]), uvAttribute.getY(vertexIndices[0])],
        [uvAttribute.getX(vertexIndices[1]), uvAttribute.getY(vertexIndices[1])],
        [uvAttribute.getX(vertexIndices[2]), uvAttribute.getY(vertexIndices[2])],
    ];

    return TRIANGLE_INTERIOR_SAMPLE_BARYCENTRICS.map(([wa, wb, wc]) => {
        const u = triangleUvs[0][0] * wa + triangleUvs[1][0] * wb + triangleUvs[2][0] * wc;
        const v = triangleUvs[0][1] * wa + triangleUvs[1][1] * wb + triangleUvs[2][1] * wc;
        return new THREE.Vector2(u, v);
    });
};

const buildProjectionSharedChains = (parts: ProjectionPartSource[]) => {
    const edgeMap = new Map<
        string,
        Array<{
            leafId: string;
            mesh: THREE.Mesh | THREE.SkinnedMesh;
            startKey: string;
            endKey: string;
            startVertexIndex: number;
            endVertexIndex: number;
        }>
    >();

    parts.forEach((part) => {
        part.triangles.forEach((triangle) => {
            const edges = [
                {
                    startKey: triangle.vertexPositionKeys[0],
                    endKey: triangle.vertexPositionKeys[1],
                    startVertexIndex: triangle.vertexIndices[0],
                    endVertexIndex: triangle.vertexIndices[1],
                },
                {
                    startKey: triangle.vertexPositionKeys[1],
                    endKey: triangle.vertexPositionKeys[2],
                    startVertexIndex: triangle.vertexIndices[1],
                    endVertexIndex: triangle.vertexIndices[2],
                },
                {
                    startKey: triangle.vertexPositionKeys[2],
                    endKey: triangle.vertexPositionKeys[0],
                    startVertexIndex: triangle.vertexIndices[2],
                    endVertexIndex: triangle.vertexIndices[0],
                },
            ];

            edges.forEach((edge) => {
                const edgeKey = getOrderedEdgeKey(edge.startKey, edge.endKey);
                const bucket = edgeMap.get(edgeKey) ?? [];
                bucket.push({
                    leafId: part.leafId,
                    mesh: part.mesh,
                    ...edge,
                });
                edgeMap.set(edgeKey, bucket);
            });
        });
    });

    const pairGraphs = new Map<
        string,
        {
            mesh: THREE.Mesh | THREE.SkinnedMesh;
            leafIds: [string, string];
            adjacency: Map<string, Set<string>>;
            vertexIndexByKey: Map<string, number>;
        }
    >();

    edgeMap.forEach((entries) => {
        const uniqueEntries = entries.filter(
            (entry, index, array) =>
                array.findIndex((candidate) => candidate.leafId === entry.leafId) === index,
        );
        if (uniqueEntries.length !== 2) {
            return;
        }

        const [left, right] = uniqueEntries;
        if (left.leafId === right.leafId || left.mesh !== right.mesh) {
            return;
        }

        const leafIds =
            left.leafId < right.leafId
                ? ([left.leafId, right.leafId] as [string, string])
                : ([right.leafId, left.leafId] as [string, string]);
        const pairKey = `${leafIds[0]}__${leafIds[1]}`;
        const graph =
            pairGraphs.get(pairKey) ??
            {
                mesh: left.mesh,
                leafIds,
                adjacency: new Map<string, Set<string>>(),
                vertexIndexByKey: new Map<string, number>(),
            };

        const addNeighbor = (fromKey: string, toKey: string, vertexIndex: number) => {
            const neighbors = graph.adjacency.get(fromKey) ?? new Set<string>();
            neighbors.add(toKey);
            graph.adjacency.set(fromKey, neighbors);
            if (!graph.vertexIndexByKey.has(fromKey)) {
                graph.vertexIndexByKey.set(fromKey, vertexIndex);
            }
        };

        addNeighbor(left.startKey, left.endKey, left.startVertexIndex);
        addNeighbor(left.endKey, left.startKey, left.endVertexIndex);
        pairGraphs.set(pairKey, graph);
    });

    const chains: ProjectionSharedChain[] = [];
    pairGraphs.forEach((graph, pairKey) => {
        const visitedEdges = new Set<string>();
        const degrees = new Map(
            [...graph.adjacency.entries()].map(([key, neighbors]) => [key, neighbors.size]),
        );
        const startKeys = [
            ...graph.adjacency.keys(),
        ].sort((left, right) => (degrees.get(left) !== 2 && degrees.get(right) === 2 ? -1 : 1));

        const edgeVisitKey = (left: string, right: string) => getOrderedEdgeKey(left, right);

        const traceChain = (startKey: string, nextKey: string) => {
            const vertexKeys = [startKey];
            let previousKey: string | null = null;
            let currentKey = startKey;
            let candidateKey = nextKey;
            let guard = 0;

            while (guard < graph.adjacency.size * 2) {
                guard += 1;
                visitedEdges.add(edgeVisitKey(currentKey, candidateKey));
                previousKey = currentKey;
                currentKey = candidateKey;
                vertexKeys.push(currentKey);

                const neighbors = [...(graph.adjacency.get(currentKey) ?? [])];
                const unvisited = neighbors.filter(
                    (neighborKey) =>
                        neighborKey !== previousKey &&
                        !visitedEdges.has(edgeVisitKey(currentKey, neighborKey)),
                );

                if (unvisited.length === 0) {
                    break;
                }

                candidateKey = unvisited[0];
            }

            if (vertexKeys.length < 2) {
                return;
            }

            chains.push({
                id: `${pairKey}-${chains.length}`,
                mesh: graph.mesh,
                leafIds: graph.leafIds,
                vertexIndices: vertexKeys.map((key) => graph.vertexIndexByKey.get(key) ?? 0),
                vertexPositionKeys: vertexKeys,
            });
        };

        startKeys.forEach((startKey) => {
            const neighbors = [...(graph.adjacency.get(startKey) ?? [])];
            neighbors.forEach((neighborKey) => {
                const visitKey = edgeVisitKey(startKey, neighborKey);
                if (visitedEdges.has(visitKey)) {
                    return;
                }
                traceChain(startKey, neighborKey);
            });
        });
    });

    return chains.filter((chain) => chain.vertexIndices.length >= 2);
};

const getTextureDebugInfo = (texture: THREE.Texture | null | undefined) => {
    if (!texture) {
        return {
            mapPresent: false,
            mapKind: 'none',
            mapFileName: null,
            imageWidth: null,
            imageHeight: null,
        };
    }

    const mapFileName =
        ((texture as THREE.Texture & { userData?: { MMD?: { mapFileName?: string } } }).userData?.MMD
            ?.mapFileName as string | undefined) ?? null;

    const sourceData = texture.source?.data as
        | {
            data?: ArrayLike<number>;
            width?: number;
            height?: number;
            constructor?: { name?: string };
        }
        | undefined;
    const image = texture.image as
        | {
            data?: ArrayLike<number>;
            width?: number;
            height?: number;
            constructor?: { name?: string };
        }
        | undefined;

    if (sourceData?.data && typeof sourceData.width === 'number' && typeof sourceData.height === 'number') {
        return {
            mapPresent: true,
            mapKind: `source:${sourceData.constructor?.name ?? 'data'}`,
            mapFileName,
            imageWidth: sourceData.width,
            imageHeight: sourceData.height,
        };
    }

    if (image?.data && typeof image.width === 'number' && typeof image.height === 'number') {
        return {
            mapPresent: true,
            mapKind: `image:${image.constructor?.name ?? 'data'}`,
            mapFileName,
            imageWidth: image.width,
            imageHeight: image.height,
        };
    }

    if (image && typeof image.width === 'number' && typeof image.height === 'number') {
        return {
            mapPresent: true,
            mapKind: image.constructor?.name ?? 'image',
            mapFileName,
            imageWidth: image.width,
            imageHeight: image.height,
        };
    }

    return {
        mapPresent: true,
        mapKind: 'unknown',
        mapFileName,
        imageWidth: null,
        imageHeight: null,
    };
};

const getGeometryGroups = (geometry: THREE.BufferGeometry, materialCount: number): GeometryGroup[] => {
    if (geometry.groups.length > 0) {
        return geometry.groups
            .filter((group) => group.materialIndex !== undefined && group.materialIndex >= 0)
            .map((group) => ({
                start: group.start,
                count: group.count,
                materialIndex: group.materialIndex as number,
            }));
    }

    const fallbackCount = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
    return materialCount > 0
        ? [
            {
                start: 0,
                count: fallbackCount,
                materialIndex: 0,
            },
        ]
        : [];
};

const ensureIndexedGeometry = (geometry: THREE.BufferGeometry) => {
    if (geometry.index) {
        return geometry;
    }

    const indexedGeometry = geometry.clone();
    const position = geometry.getAttribute('position');
    const indices = Array.from({ length: position.count }, (_, index) => index);
    indexedGeometry.setIndex(indices);
    return indexedGeometry;
};

const getTexturePixelReader = (texture: THREE.Texture | null | undefined) => {
    if (!texture || !texture.image) {
        return null;
    }

    if (texturePixelReaderCache.has(texture)) {
        return texturePixelReaderCache.get(texture) ?? null;
    }

    const dataTextureLikeImage =
        (texture.source?.data as {
            data?: ArrayLike<number>;
            width?: number;
            height?: number;
        } | null | undefined) ??
        (texture.image as {
            data?: ArrayLike<number>;
            width?: number;
            height?: number;
        });

    if (
        dataTextureLikeImage?.data &&
        typeof dataTextureLikeImage.width === 'number' &&
        typeof dataTextureLikeImage.height === 'number'
    ) {
        const { data, width, height } = dataTextureLikeImage;
        const stride = Math.max(3, Math.round(data.length / (width * height)));

        const reader = (u: number, v: number) => {
            const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
            const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
            const offset = (y * width + x) * stride;
            return {
                r: Number(data[offset] ?? 255),
                g: Number(data[offset + 1] ?? data[offset] ?? 255),
                b: Number(data[offset + 2] ?? data[offset] ?? 255),
                a: Number(data[offset + 3] ?? 255),
            };
        };
        texturePixelReaderCache.set(texture, reader);
        return reader;
    }

    if (texture.image instanceof ImageData) {
        const { data, width, height } = texture.image;
        const reader = (u: number, v: number) => {
            const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
            const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
            const offset = (y * width + x) * 4;
            return {
                r: data[offset],
                g: data[offset + 1],
                b: data[offset + 2],
                a: data[offset + 3],
            };
        };
        texturePixelReaderCache.set(texture, reader);
        return reader;
    }

    if (texture.image instanceof HTMLCanvasElement) {
        const context = texture.image.getContext('2d');
        if (!context) {
            texturePixelReaderCache.set(texture, null);
            return null;
        }
        const { width, height } = texture.image;
        const imageData = context.getImageData(0, 0, width, height).data;
        const reader = (u: number, v: number) => {
            const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
            const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
            const offset = (y * width + x) * 4;
            return {
                r: imageData[offset],
                g: imageData[offset + 1],
                b: imageData[offset + 2],
                a: imageData[offset + 3],
            };
        };
        texturePixelReaderCache.set(texture, reader);
        return reader;
    }

    if (
        texture.image instanceof HTMLImageElement ||
        texture.image instanceof ImageBitmap ||
        texture.image instanceof OffscreenCanvas
    ) {
        const canvas = document.createElement('canvas');
        const width = texture.image.width;
        const height = texture.image.height;
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
            texturePixelReaderCache.set(texture, null);
            return null;
        }
        context.drawImage(texture.image, 0, 0, width, height);
        const imageData = context.getImageData(0, 0, width, height).data;
        const reader = (u: number, v: number) => {
            const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
            const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
            const offset = (y * width + x) * 4;
            return {
                r: imageData[offset],
                g: imageData[offset + 1],
                b: imageData[offset + 2],
                a: imageData[offset + 3],
            };
        };
        texturePixelReaderCache.set(texture, reader);
        return reader;
    }

    texturePixelReaderCache.set(texture, null);
    return null;
};

export const areModelTexturesReady = (root: THREE.Object3D) => {
    let ready = true;

    root.traverse((node) => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh)) {
            return;
        }

        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
            const texturedMaterial = material as THREE.Material & {
                map?: THREE.Texture | null;
            };
            const map = texturedMaterial.map;
            if (!map) {
                return;
            }

            const image = ((map.source?.data as
                | {
                    complete?: boolean;
                    width?: number;
                    height?: number;
                    data?: ArrayLike<number>;
                }
                | undefined) ??
                (map.image as
                    | {
                        complete?: boolean;
                        width?: number;
                        height?: number;
                        data?: ArrayLike<number>;
                    }
                    | undefined));

            if (!image) {
                ready = false;
                return;
            }

            if (
                image.data &&
                typeof image.width === 'number' &&
                typeof image.height === 'number' &&
                image.width > 1 &&
                image.height > 1
            ) {
                return;
            }

            if (typeof image.complete === 'boolean' && !image.complete) {
                ready = false;
                return;
            }

            if (!image.width || !image.height) {
                ready = false;
                return;
            }

            if (image.width <= 1 && image.height <= 1) {
                ready = false;
            }
        });
    });

    return ready;
};

const getTriangleColor = (
    uvAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
    material: THREE.Material,
    vertexIndices: [number, number, number],
) => {
    const texturedMaterial = material as THREE.Material & {
        map?: THREE.Texture | null;
        color?: THREE.Color;
    };
    const textureReader = getTexturePixelReader(texturedMaterial.map);
    const materialColor = texturedMaterial.color?.clone() ?? new THREE.Color(1, 1, 1);

    if (uvAttribute && textureReader) {
        const rgb = averageRgb(
            getTriangleSampleUvs(uvAttribute, vertexIndices).map((uv) => {
                texturedMaterial.map?.transformUv(uv);
                const sampled = textureReader(uv.x, uv.y);
                return [
                    Math.round((sampled.r / 255) * materialColor.r * 255),
                    Math.round((sampled.g / 255) * materialColor.g * 255),
                    Math.round((sampled.b / 255) * materialColor.b * 255),
                ] as [number, number, number];
            }),
        );
        return { rgb, label: colorLabelFromKey(colorKeyFromRgb(...rgb)) };
    }

    const rgb: [number, number, number] = [
        Math.round(materialColor.r * 255),
        Math.round(materialColor.g * 255),
        Math.round(materialColor.b * 255),
    ];
    return { rgb, label: colorLabelFromColor(materialColor) };
};

export const getTriangleSampleDebugInfo = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    vertexIndices: [number, number, number],
): TriangleSampleDebugInfo => {
    const uvAttribute = geometry.getAttribute('uv');
    const texturedMaterial = material as THREE.Material & {
        map?: THREE.Texture | null;
        color?: THREE.Color;
        emissive?: THREE.Color;
    };
    const textureReader = getTexturePixelReader(texturedMaterial.map);
    const materialColor = texturedMaterial.color?.clone() ?? new THREE.Color(1, 1, 1);
    const effectiveAlpha = material.opacity;
    const materialRgb: [number, number, number] = [
        Math.round(materialColor.r * 255),
        Math.round(materialColor.g * 255),
        Math.round(materialColor.b * 255),
    ];

    if (!uvAttribute || !textureReader) {
        return {
            uv: null,
            materialColor: {
                rgb: materialRgb,
                hex: colorLabelFromColor(materialColor),
            },
            textureColor: null,
            finalColor: {
                rgb: materialRgb,
                hex: colorLabelFromColor(materialColor),
            },
            visibleColorOnBlack: {
                rgb: materialRgb.map((channel) => Math.round(channel * effectiveAlpha)) as [
                    number,
                    number,
                    number,
                ],
                hex: colorLabelFromKey(
                    colorKeyFromRgb(
                        Math.round(materialRgb[0] * effectiveAlpha),
                        Math.round(materialRgb[1] * effectiveAlpha),
                        Math.round(materialRgb[2] * effectiveAlpha),
                    ),
                ),
                alpha: Math.round(effectiveAlpha * 255),
            },
        };
    }

    const sampleUvs = getTriangleSampleUvs(uvAttribute, vertexIndices);
    const sampledPixels = sampleUvs.map((uv) => {
        texturedMaterial.map?.transformUv(uv);
        return {
            uv,
            pixel: textureReader(uv.x, uv.y),
        };
    });
    const finalRgb = averageRgb(
        sampledPixels.map(({ pixel }) => [
            Math.round((pixel.r / 255) * materialColor.r * 255),
            Math.round((pixel.g / 255) * materialColor.g * 255),
            Math.round((pixel.b / 255) * materialColor.b * 255),
        ]),
    );
    const textureRgb = averageRgb(
        sampledPixels.map(({ pixel }) => [pixel.r, pixel.g, pixel.b] as [number, number, number]),
    );
    const averageAlpha = Math.round(
        sampledPixels.reduce((accumulator, { pixel }) => accumulator + pixel.a, 0) / sampledPixels.length,
    );
    const compositeAlpha = (averageAlpha / 255) * effectiveAlpha;
    const visibleRgb: [number, number, number] = [
        Math.round(finalRgb[0] * compositeAlpha),
        Math.round(finalRgb[1] * compositeAlpha),
        Math.round(finalRgb[2] * compositeAlpha),
    ];

    return {
        uv: [sampledPixels[0].uv.x, sampledPixels[0].uv.y],
        materialColor: {
            rgb: materialRgb,
            hex: colorLabelFromColor(materialColor),
        },
        textureColor: {
            rgb: textureRgb,
            hex: colorLabelFromKey(colorKeyFromRgb(...textureRgb)),
            alpha: averageAlpha,
        },
        finalColor: {
            rgb: finalRgb,
            hex: colorLabelFromKey(colorKeyFromRgb(...finalRgb)),
        },
        visibleColorOnBlack: {
            rgb: visibleRgb,
            hex: colorLabelFromKey(colorKeyFromRgb(...visibleRgb)),
            alpha: Math.round(compositeAlpha * 255),
        },
    };
};

const buildAdjacencyEdges = (triangles: TriangleRecord[]) => {
    const edgeMap = new Map<string, string[]>();
    const triangleIndexById = new Map(triangles.map((triangle, index) => [triangle.id, index]));

    triangles.forEach((triangle) => {
        const [a, b, c] = triangle.vertexPositionKeys;
        const edges: Array<[string, string]> = [
            [a, b],
            [b, c],
            [c, a],
        ];
        edges.forEach(([left, right]) => {
            const edgeKey = left < right ? `${left}|${right}` : `${right}|${left}`;
            const bucket = edgeMap.get(edgeKey) ?? [];
            bucket.push(triangle.id);
            edgeMap.set(edgeKey, bucket);
        });
    });

    const uniquePairs = new Set<string>();
    const edges: TriangleAdjacencyEdge[] = [];

    edgeMap.forEach((triangleIds) => {
        if (triangleIds.length < 2) {
            return;
        }

        for (let left = 0; left < triangleIds.length; left += 1) {
            for (let right = left + 1; right < triangleIds.length; right += 1) {
                const leftIndex = triangleIndexById.get(triangleIds[left]);
                const rightIndex = triangleIndexById.get(triangleIds[right]);
                if (leftIndex === undefined || rightIndex === undefined) {
                    continue;
                }

                const pairKey =
                    leftIndex < rightIndex ? `${leftIndex}-${rightIndex}` : `${rightIndex}-${leftIndex}`;
                if (uniquePairs.has(pairKey)) {
                    continue;
                }
                uniquePairs.add(pairKey);

                const diff = colorDistance(triangles[leftIndex].colorRgb, triangles[rightIndex].colorRgb);
                edges.push({
                    leftIndex,
                    rightIndex,
                    diff,
                    bucket: Math.floor(diff / COLOR_EDGE_BUCKET_SIZE),
                });
            }
        }
    });

    return edges;
};

const buildColorRegions = (triangles: TriangleRecord[]) => {
    const parent = triangles.map((_, index) => index);
    const rank = triangles.map(() => 0);
    const sumRgb = triangles.map((triangle) => [...triangle.colorRgb] as [number, number, number]);
    const counts = triangles.map(() => 1);
    const adjacencyEdges = buildAdjacencyEdges(triangles);

    const find = (index: number): number => {
        if (parent[index] !== index) {
            parent[index] = find(parent[index]);
        }
        return parent[index];
    };

    const union = (leftIndex: number, rightIndex: number) => {
        let leftRoot = find(leftIndex);
        let rightRoot = find(rightIndex);
        if (leftRoot === rightRoot) {
            return;
        }

        if (rank[leftRoot] < rank[rightRoot]) {
            [leftRoot, rightRoot] = [rightRoot, leftRoot];
        }

        parent[rightRoot] = leftRoot;
        if (rank[leftRoot] === rank[rightRoot]) {
            rank[leftRoot] += 1;
        }

        sumRgb[leftRoot] = [
            sumRgb[leftRoot][0] + sumRgb[rightRoot][0],
            sumRgb[leftRoot][1] + sumRgb[rightRoot][1],
            sumRgb[leftRoot][2] + sumRgb[rightRoot][2],
        ];
        counts[leftRoot] += counts[rightRoot];
    };

    const bucketedEdges = new Map<number, TriangleAdjacencyEdge[]>();
    adjacencyEdges.forEach((edge) => {
        const bucket = bucketedEdges.get(edge.bucket) ?? [];
        bucket.push(edge);
        bucketedEdges.set(edge.bucket, bucket);
    });

    [...bucketedEdges.keys()]
        .sort((left, right) => left - right)
        .forEach((bucketKey) => {
            bucketedEdges.get(bucketKey)?.forEach((edge) => {
                if (edge.diff > COLOR_LOCAL_THRESHOLD) {
                    return;
                }
                union(edge.leftIndex, edge.rightIndex);
            });
        });

    const clusters = new Map<number, TriangleCluster>();

    triangles.forEach((triangle, triangleIndex) => {
        const root = find(triangleIndex);
        const existing = clusters.get(root);
        if (existing) {
            existing.triangles.push(triangle);
            return;
        }

        clusters.set(root, {
            id: root,
            triangles: [triangle],
            centroid: [
                sumRgb[root][0] / counts[root],
                sumRgb[root][1] / counts[root],
                sumRgb[root][2] / counts[root],
            ],
        });
    });

    const activeClusters = new Map(clusters);
    const clusterByTriangleId = new Map<string, number>();
    activeClusters.forEach((cluster) => {
        cluster.triangles.forEach((triangle) => {
            clusterByTriangleId.set(triangle.id, cluster.id);
        });
    });

    const clusterAdjacency = new Map<number, Map<number, { sharedEdgeCount: number; minDiff: number }>>();
    const linkClusters = (fromId: number, toId: number, diff: number) => {
        const neighbors = clusterAdjacency.get(fromId) ?? new Map<number, { sharedEdgeCount: number; minDiff: number }>();
        const current = neighbors.get(toId);
        if (current) {
            current.sharedEdgeCount += 1;
            current.minDiff = Math.min(current.minDiff, diff);
        } else {
            neighbors.set(toId, {
                sharedEdgeCount: 1,
                minDiff: diff,
            });
        }
        clusterAdjacency.set(fromId, neighbors);
    };

    adjacencyEdges.forEach((edge) => {
        const leftClusterId = clusterByTriangleId.get(triangles[edge.leftIndex].id);
        const rightClusterId = clusterByTriangleId.get(triangles[edge.rightIndex].id);
        if (
            leftClusterId === undefined ||
            rightClusterId === undefined ||
            leftClusterId === rightClusterId
        ) {
            return;
        }

        linkClusters(leftClusterId, rightClusterId, edge.diff);
        linkClusters(rightClusterId, leftClusterId, edge.diff);
    });

    const recomputeCentroid = (cluster: TriangleCluster): [number, number, number] =>
        averageRgb(cluster.triangles.map((triangle) => triangle.colorRgb));

    const mergeClusters = (sourceId: number, targetId: number) => {
        const source = activeClusters.get(sourceId);
        const target = activeClusters.get(targetId);
        if (!source || !target) {
            return;
        }

        target.triangles.push(...source.triangles);
        target.centroid = recomputeCentroid(target);
        source.triangles.forEach((triangle) => {
            clusterByTriangleId.set(triangle.id, targetId);
        });

        const sourceNeighbors = clusterAdjacency.get(sourceId) ?? new Map();
        sourceNeighbors.forEach((sourceLink, neighborId) => {
            if (neighborId === targetId || !activeClusters.has(neighborId)) {
                return;
            }

            const targetNeighbors = clusterAdjacency.get(targetId) ?? new Map<number, { sharedEdgeCount: number; minDiff: number }>();
            const targetLink = targetNeighbors.get(neighborId);
            if (targetLink) {
                targetLink.sharedEdgeCount += sourceLink.sharedEdgeCount;
                targetLink.minDiff = Math.min(targetLink.minDiff, sourceLink.minDiff);
            } else {
                targetNeighbors.set(neighborId, { ...sourceLink });
            }
            clusterAdjacency.set(targetId, targetNeighbors);

            const neighborLinks = clusterAdjacency.get(neighborId) ?? new Map<number, { sharedEdgeCount: number; minDiff: number }>();
            neighborLinks.delete(sourceId);
            const reverseLink = neighborLinks.get(targetId);
            if (reverseLink) {
                reverseLink.sharedEdgeCount += sourceLink.sharedEdgeCount;
                reverseLink.minDiff = Math.min(reverseLink.minDiff, sourceLink.minDiff);
            } else {
                neighborLinks.set(targetId, { ...sourceLink });
            }
            clusterAdjacency.set(neighborId, neighborLinks);
        });

        clusterAdjacency.get(targetId)?.delete(sourceId);
        clusterAdjacency.delete(sourceId);
        activeClusters.delete(sourceId);
    };

    let mergedAny = true;
    while (mergedAny) {
        mergedAny = false;

        const smallClusters = [...activeClusters.values()]
            .filter((cluster) => cluster.triangles.length <= SMALL_REGION_TRIANGLE_LIMIT)
            .sort((left, right) => left.triangles.length - right.triangles.length);

        for (const cluster of smallClusters) {
            if (!activeClusters.has(cluster.id)) {
                continue;
            }

            const targetId = [...(clusterAdjacency.get(cluster.id)?.entries() ?? [])]
                .filter(
                    ([neighborId, link]) =>
                        activeClusters.has(neighborId) && link.minDiff <= SMALL_REGION_MERGE_THRESHOLD,
                )
                .sort((left, right) => {
                    if (right[1].sharedEdgeCount !== left[1].sharedEdgeCount) {
                        return right[1].sharedEdgeCount - left[1].sharedEdgeCount;
                    }
                    if (left[1].minDiff !== right[1].minDiff) {
                        return left[1].minDiff - right[1].minDiff;
                    }
                    const leftSize = activeClusters.get(left[0])?.triangles.length ?? 0;
                    const rightSize = activeClusters.get(right[0])?.triangles.length ?? 0;
                    return rightSize - leftSize;
                })[0]?.[0];

            if (targetId === undefined) {
                continue;
            }

            mergeClusters(cluster.id, targetId);
            mergedAny = true;
        }
    }

    return [...activeClusters.values()];
};

const cloneLeafMaterial = (material: THREE.Material) => {
    const sourceMaterial = material as THREE.Material & {
        map?: THREE.Texture | null;
        alphaMap?: THREE.Texture | null;
        color?: THREE.Color;
        side?: THREE.Side;
        alphaTest?: number;
    };

    return new THREE.MeshBasicMaterial({
        map: sourceMaterial.map ?? null,
        alphaMap: sourceMaterial.alphaMap ?? null,
        color: sourceMaterial.color?.clone() ?? new THREE.Color(0xffffff),
        side: sourceMaterial.side ?? THREE.FrontSide,
        transparent: material.transparent,
        opacity: material.opacity,
        alphaTest: sourceMaterial.alphaTest ?? 0,
    });
};

const shouldExcludeMaterialForModel = (modelName: string | null | undefined, materialName: string) => {
    if (!modelName) {
        return false;
    }

    const keywords = MODEL_MATERIAL_EXCLUSION_KEYWORDS[modelName];
    if (!keywords || keywords.length === 0) {
        return false;
    }

    return keywords.some((keyword) => materialName.includes(keyword));
};

const buildMeshSegmentation = (
    mesh: THREE.Mesh | THREE.SkinnedMesh,
    leafMaterialMap: Map<string, THREE.Material>,
    debugMaterials: MaterialDebugInfo[],
    projectionParts: ProjectionPartSource[],
    modelName: string | null | undefined,
) => {
    const indexedGeometry = ensureIndexedGeometry(mesh.geometry);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = getGeometryGroups(indexedGeometry, materials.length);
    const indexArray = indexedGeometry.index!.array;
    const uvAttribute = indexedGeometry.getAttribute('uv');
    const positionAttribute = indexedGeometry.getAttribute('position');
    const nextIndexValues: number[] = [];
    const nextGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
    const nextMaterials: THREE.Material[] = [];
    const meshPartNodes: PartNode[] = [];
    const leafIdByMaterialIndex: string[] = [];

    groups.forEach((group, groupIndex) => {
        const material = materials[group.materialIndex];
        if (!material) {
            return;
        }

        const materialName = material.name?.trim() || `material-${group.materialIndex}`;
        if (shouldExcludeMaterialForModel(modelName, materialName)) {
            return;
        }
        const materialNodeChildren: PartNode[] = [];
        const materialLeafIds: string[] = [];
        const materialTriangleCount = Math.floor(group.count / 3);
        const materialTriangles: TriangleRecord[] = [];
        const sampledColors = new Set<string>();

        for (let offset = group.start; offset < group.start + group.count; offset += 3) {
            const vertexIndices: [number, number, number] = [
                Number(indexArray[offset]),
                Number(indexArray[offset + 1]),
                Number(indexArray[offset + 2]),
            ];
            const color = getTriangleColor(uvAttribute, material, vertexIndices);
            const triangleId = `${mesh.uuid}-g${groupIndex}-t${offset}`;
            const triangle: TriangleRecord = {
                id: triangleId,
                vertexIndices,
                vertexPositionKeys: [
                    getPositionKey(positionAttribute, vertexIndices[0]),
                    getPositionKey(positionAttribute, vertexIndices[1]),
                    getPositionKey(positionAttribute, vertexIndices[2]),
                ],
                colorRgb: color.rgb,
                colorLabel: color.label,
            };
            if (sampledColors.size < 5) {
                sampledColors.add(color.label);
            }
            materialTriangles.push(triangle);
        }

        const texturedMaterial = material as THREE.Material & {
            map?: THREE.Texture | null;
            color?: THREE.Color;
            userData?: { MMD?: { mapFileName?: string } };
        };
        const textureDebug = getTextureDebugInfo(texturedMaterial.map);
        debugMaterials.push({
            materialName,
            ...textureDebug,
            mapFileName: textureDebug.mapFileName ?? texturedMaterial.userData?.MMD?.mapFileName ?? null,
            materialColor: colorLabelFromColor(texturedMaterial.color?.clone() ?? new THREE.Color(1, 1, 1)),
            sampleColors: [...sampledColors],
        });

        buildColorRegions(materialTriangles)
            .sort((left, right) => right.triangles.length - left.triangles.length)
            .forEach((cluster, clusterIndex) => {
                const centroid = cluster.centroid;
                const colorLabel = rgbToHex([
                    Math.round(centroid[0]),
                    Math.round(centroid[1]),
                    Math.round(centroid[2]),
                ]);
                const colorChildren: PartNode[] = [];
                const colorLeafIds: string[] = [];

                const leafId = `${mesh.uuid}-g${groupIndex}-m${group.materialIndex}-cg${clusterIndex}`;
                const leafMaterial = cloneLeafMaterial(material);
                leafMaterialMap.set(leafId, leafMaterial);
                nextMaterials.push(leafMaterial);
                leafIdByMaterialIndex.push(leafId);

                const start = nextIndexValues.length;
                cluster.triangles.forEach((triangle) => {
                    nextIndexValues.push(...triangle.vertexIndices);
                });
                const count = cluster.triangles.length * 3;
                nextGroups.push({
                    start,
                    count,
                    materialIndex: nextMaterials.length - 1,
                });
                if (cluster.triangles.length >= 1) {
                    projectionParts.push({
                        leafId,
                        mesh,
                        triangleCount: cluster.triangles.length,
                        color: colorLabel,
                        triangles: cluster.triangles.map((triangle) => ({
                            vertexIndices: triangle.vertexIndices,
                            vertexPositionKeys: triangle.vertexPositionKeys,
                        })),
                    });
                }

                const componentNode: PartNode = {
                    id: leafId,
                    label: 'Region',
                    depth: 2,
                    triangleCount: cluster.triangles.length,
                    leafIds: [leafId],
                    swatchColor: colorLabel,
                    children: [],
                };
                colorChildren.push(componentNode);
                colorLeafIds.push(leafId);
                materialLeafIds.push(leafId);

                colorChildren.sort((left, right) => right.triangleCount - left.triangleCount);
                materialNodeChildren.push({
                    id: `${mesh.uuid}-g${groupIndex}-m${group.materialIndex}-cg${clusterIndex}`,
                    label: colorLabel,
                    depth: 1,
                    triangleCount: cluster.triangles.length,
                    leafIds: colorLeafIds,
                    swatchColor: colorLabel,
                    children: colorChildren,
                });
            });

        materialNodeChildren.sort((left, right) => right.triangleCount - left.triangleCount);
        meshPartNodes.push({
            id: `${mesh.uuid}-g${groupIndex}-m${group.materialIndex}`,
            label: materialName,
            depth: 0,
            triangleCount: materialTriangleCount,
            leafIds: materialLeafIds,
            swatchColor: undefined,
            children: materialNodeChildren,
        });
    });

    const segmentedGeometry = indexedGeometry.clone();
    segmentedGeometry.clearGroups();
    segmentedGeometry.setIndex(nextIndexValues);
    nextGroups.forEach((group) => {
        segmentedGeometry.addGroup(group.start, group.count, group.materialIndex);
    });

    mesh.geometry = segmentedGeometry;
    mesh.material = nextMaterials;
    mesh.userData.partLeafIdByMaterialIndex = leafIdByMaterialIndex;

    return meshPartNodes;
};

export const splitModelParts = (
    root: THREE.Object3D,
    modelName: string | null | undefined = root.name,
): SegmentationResult => {
    const leafMaterialMap = new Map<string, THREE.Material>();
    const parts: PartNode[] = [];
    const debugMaterials: MaterialDebugInfo[] = [];
    const projectionParts: ProjectionPartSource[] = [];

    root.traverse((node) => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh)) {
            return;
        }

        parts.push(
            ...buildMeshSegmentation(
                node,
                leafMaterialMap,
                debugMaterials,
                projectionParts,
                modelName,
            ),
        );
    });

    const projectionSharedChains = buildProjectionSharedChains(projectionParts);

    return {
        parts: parts.sort((left, right) => right.triangleCount - left.triangleCount),
        leafMaterialMap,
        debugMaterials,
        projectionParts,
        projectionSharedChains,
    };
};

export const MODEL_PARTS_DEBUG = {
    colorEdgeBucketSize: COLOR_EDGE_BUCKET_SIZE,
    colorLocalThreshold: COLOR_LOCAL_THRESHOLD,
    smallRegionTriangleLimit: SMALL_REGION_TRIANGLE_LIMIT,
    smallRegionMergeThreshold: SMALL_REGION_MERGE_THRESHOLD,
    triangleColorSampleMode: TRIANGLE_COLOR_SAMPLE_MODE,
    triangleInteriorSampleBarycentrics: TRIANGLE_INTERIOR_SAMPLE_BARYCENTRICS,
    connectivityMode: 'shared-position-edge',
    positionKeyEpsilon: POSITION_KEY_EPSILON,
} as const;
