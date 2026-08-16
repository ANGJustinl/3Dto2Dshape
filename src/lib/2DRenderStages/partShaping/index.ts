import * as THREE from 'three';
import type { GpuDepthAtlasState, RasterizedPartData } from '../partRasterization/rasterizer';
import type { ProjectionPartSource } from '../../modelParts';
import { recordPerfSample } from '../../perfLogger';
import type { ProjectionFrameResult } from '../meshProjection/projector';
import type {
    MeshProjectionCache,
    ProjectionMaskState,
    ProjectionOverlaySettings,
} from '../../2DRenderShared/types';
import { getGpuPartRasterizer, type GpuRasterizedPartData } from '../partRasterization/rasterizer';
import { buildProjectedPartShapeFromRasterData } from './partAssembler';
import { getPaintLayerForShade, shadeColorForLayer } from '../../2DRenderShared/paintStyle';
import { resolvePartStyle, type ResolvedPartStyle } from '../../2DRenderShared/focusResolver';
import { getRasterContourClient } from '../../wasm/rasterContourClient';

const projectPointDepth = (
    projectionCache: MeshProjectionCache,
    vertexIndex: number,
): number => projectionCache.depth[vertexIndex];

const getTriangleShade = (
    projectionCache: MeshProjectionCache,
    vertexIndices: [number, number, number],
    lightDirection: THREE.Vector3,
) => {
    const left = new THREE.Vector3(
        projectionCache.worldX[vertexIndices[0]],
        projectionCache.worldY[vertexIndices[0]],
        projectionCache.worldZ[vertexIndices[0]],
    );
    const middle = new THREE.Vector3(
        projectionCache.worldX[vertexIndices[1]],
        projectionCache.worldY[vertexIndices[1]],
        projectionCache.worldZ[vertexIndices[1]],
    );
    const right = new THREE.Vector3(
        projectionCache.worldX[vertexIndices[2]],
        projectionCache.worldY[vertexIndices[2]],
        projectionCache.worldZ[vertexIndices[2]],
    );

    const normal = middle.sub(left).cross(right.sub(left)).normalize();
    return normal.dot(lightDirection);
};

const buildPaintLayerParts = (
    part: ProjectionPartSource,
    projectionCache: MeshProjectionCache,
    settings: ProjectionOverlaySettings,
    resolvedStyle: ResolvedPartStyle,
) => {
    const lightDirection = new THREE.Vector3(...settings.lightDirection).normalize();
    const trianglesByLayer = new Map<ReturnType<typeof getPaintLayerForShade>, ProjectionPartSource['triangles']>();

    part.triangles.forEach((triangle) => {
        const shade = getTriangleShade(projectionCache, triangle.vertexIndices, lightDirection);
        const layer = getPaintLayerForShade(shade, settings);
        const layerTriangles = trianglesByLayer.get(layer) ?? [];
        layerTriangles.push(triangle);
        trianglesByLayer.set(layer, layerTriangles);
    });

    const layers: ProjectionPartSource[] = [];
    (['shadow', 'base', 'highlight'] as const).forEach((paintLayer) => {
        const triangles = trianglesByLayer.get(paintLayer) ?? [];
        if (triangles.length === 0) {
            return;
        }

        layers.push({
            ...part,
            leafId: `${part.leafId}::${paintLayer}`,
            sourceLeafId: part.leafId,
            paintLayer,
            focusLevel: resolvedStyle.focusLevel,
            macroGroup: resolvedStyle.macroGroup,
            shapeBudget: resolvedStyle.shapeBudget,
            simplifyMultiplier: resolvedStyle.simplifyMultiplier,
            accentScore: resolvedStyle.accentScore,
            connectivityRole: resolvedStyle.connectivityRole,
            triangleCount: triangles.length,
            color: shadeColorForLayer(part.color, paintLayer, settings),
            triangles,
        });
    });
    return layers;
};

const applyGlobalDepthVisibility = (
    rasterResults: Array<GpuRasterizedPartData | null>,
    viewportWidth: number,
    viewportHeight: number,
) => {
    const globalDepth = new Float32Array(viewportWidth * viewportHeight);
    globalDepth.fill(Number.POSITIVE_INFINITY);

    rasterResults.forEach((rasterData) => {
        if (!rasterData) {
            return;
        }

        for (let localY = 0; localY < rasterData.height; localY += 1) {
            for (let localX = 0; localX < rasterData.width; localX += 1) {
                const localIndex = localY * rasterData.width + localX;
                if (rasterData.occupied[localIndex] === 0) {
                    continue;
                }

                const screenX = rasterData.offsetX + localX;
                const screenY = rasterData.offsetY + localY;
                if (
                    screenX < 0 ||
                    screenY < 0 ||
                    screenX >= viewportWidth ||
                    screenY >= viewportHeight
                ) {
                    continue;
                }

                const screenIndex = screenY * viewportWidth + screenX;
                globalDepth[screenIndex] = Math.min(globalDepth[screenIndex], rasterData.depth[localIndex]);
            }
        }
    });

    rasterResults.forEach((rasterData) => {
        if (!rasterData) {
            return;
        }

        for (let localY = 0; localY < rasterData.height; localY += 1) {
            for (let localX = 0; localX < rasterData.width; localX += 1) {
                const localIndex = localY * rasterData.width + localX;
                if (rasterData.occupied[localIndex] === 0) {
                    continue;
                }

                const screenX = rasterData.offsetX + localX;
                const screenY = rasterData.offsetY + localY;
                if (
                    screenX < 0 ||
                    screenY < 0 ||
                    screenX >= viewportWidth ||
                    screenY >= viewportHeight
                ) {
                    rasterData.occupied[localIndex] = 0;
                    continue;
                }

                const globalDepthValue = globalDepth[screenY * viewportWidth + screenX];
                if (rasterData.depth[localIndex] > globalDepthValue + 0.0005) {
                    rasterData.occupied[localIndex] = 0;
                }
            }
        }
    });
};

const buildWasmRasterInputs = (preparedParts: Array<{
    part: ProjectionPartSource;
    projectionCache: MeshProjectionCache;
    fallbackDepth: number;
}>) => preparedParts.map((prepared) => {
    const triangleData = new Float32Array(prepared.part.triangles.length * 12);
    let offset = 0;
    prepared.part.triangles.forEach((triangle) => {
        triangle.vertexIndices.forEach((vertexIndex) => {
            triangleData[offset] = prepared.projectionCache.screenX[vertexIndex];
            triangleData[offset + 1] = prepared.projectionCache.screenY[vertexIndex];
            triangleData[offset + 2] = prepared.projectionCache.depth[vertexIndex];
            triangleData[offset + 3] = 0;
            offset += 4;
        });
    });
    return {
        part: prepared.part,
        triangleData,
        fallbackDepth: prepared.fallbackDepth,
    };
});

export const shapeProjectedParts = async (
    parts: ProjectionPartSource[],
    state: ProjectionMaskState | null,
    settings: ProjectionOverlaySettings,
    visibleLeafIds: Set<string> | null,
    frame: ProjectionFrameResult,
) => {
    if (!state) {
        return null;
    }

    const totalStart = performance.now();
    const filteredParts = parts.filter(
        (part) =>
            part.triangleCount >= Math.max(1, settings.minTriangleCount) &&
            (visibleLeafIds ? visibleLeafIds.has(part.leafId) : true),
    );
    if (filteredParts.length === 0) {
        return {
            shapes: [],
            depthAtlas: null as GpuDepthAtlasState | null,
        };
    }

    const requestedBackend = settings.cpuRasterBackend ?? 'ts';
    const wasmClient = getRasterContourClient();
    const prepareStart = performance.now();
    const preparedParts = filteredParts
        .flatMap((part) => {
            const projectionCache = frame.getProjectionCache(part.mesh);
            if (!projectionCache) {
                return [];
            }

            const resolvedStyle = resolvePartStyle(part, projectionCache, settings);

            return buildPaintLayerParts(part, projectionCache, settings, resolvedStyle).map((paintPart) => {
                const fallbackDepth =
                    paintPart.triangles[0]?.vertexIndices !== undefined
                        ? (projectPointDepth(projectionCache, paintPart.triangles[0].vertexIndices[0]) +
                              projectPointDepth(projectionCache, paintPart.triangles[0].vertexIndices[1]) +
                              projectPointDepth(projectionCache, paintPart.triangles[0].vertexIndices[2])) /
                          3
                        : Number.POSITIVE_INFINITY;

                return {
                    part: paintPart,
                    projectionCache,
                    fallbackDepth,
                };
            });
        });
    const prepareMs = performance.now() - prepareStart;

    const rasterStart = performance.now();
    let rasterResults: Array<RasterizedPartData | null>;
    let depthAtlas: GpuDepthAtlasState | null;
    if (requestedBackend !== 'ts') {
        const wasmResult = await wasmClient.runBatch(
            frame.width,
            frame.height,
            buildWasmRasterInputs(preparedParts),
        );
        if (!wasmResult) {
            return null;
        }
        rasterResults = wasmResult.parts;
        const rasterizer = getGpuPartRasterizer();
        depthAtlas = await rasterizer.uploadDepthAtlasFromRasterData(rasterResults);
    } else {
        const rasterizer = getGpuPartRasterizer();
        rasterResults = await rasterizer.rasterizeBatch(preparedParts);
        applyGlobalDepthVisibility(rasterResults, frame.width, frame.height);
        depthAtlas = rasterizer.getDepthAtlasState();
    }
    const rasterMs = performance.now() - rasterStart;

    let buildSharedChainsMs = 0;
    let extractLoopsMs = 0;
    let simplifyLoopsMs = 0;
    let finalizeShapeMs = 0;
    const buildStart = performance.now();
    const shapes = preparedParts
        .map((preparedPart, index) => {
            const rasterData = rasterResults[index] ?? null;
            if (!rasterData) {
                return null;
            }

            const result = buildProjectedPartShapeFromRasterData(
                preparedPart.part,
                state,
                preparedPart.projectionCache,
                settings,
                rasterData,
            );
            buildSharedChainsMs += result.timings.buildSharedChains;
            extractLoopsMs += result.timings.extractLoops;
            simplifyLoopsMs += result.timings.simplifyLoops;
            finalizeShapeMs += result.timings.finalizeShape;
            return result.shape;
        })
        .filter((part): part is NonNullable<typeof part> => part !== null)
        .sort((left, right) => {
            const depthOrder = right.depth - left.depth;
            if (Math.abs(depthOrder) > 0.0001) {
                return depthOrder;
            }
            const focusRank = { abstract: 0, support: 1, focal: 2 } as const;
            const focusOrder = focusRank[right.focusLevel] - focusRank[left.focusLevel];
            if (focusOrder !== 0) {
                return focusOrder;
            }
            return left.stableId.localeCompare(right.stableId);
        });
    const buildTotalMs = performance.now() - buildStart;

    recordPerfSample({
        label: 'part-projection',
        values: {
            prepareParts: prepareMs,
            rasterizeBatch: rasterMs,
            buildSharedChains: buildSharedChainsMs,
            extractLoops: extractLoopsMs,
            simplifyLoops: simplifyLoopsMs,
            finalizeShapes: finalizeShapeMs,
            buildShapesTotal: buildTotalMs,
            total: performance.now() - totalStart,
        },
    });

    return {
        shapes,
        depthAtlas,
    };
};
