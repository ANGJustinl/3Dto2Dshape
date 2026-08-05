import type { GpuDepthAtlasState } from '../partRasterization/rasterizer';
import type { ProjectionPartSource } from '../../modelParts';
import { recordPerfSample } from '../../perfLogger';
import type { ProjectionFrameResult } from '../meshProjection/projector';
import type {
    MeshProjectionCache,
    ProjectionMaskState,
    ProjectionOverlaySettings,
} from '../../2DRenderShared/types';
import { getGpuPartRasterizer } from '../partRasterization/rasterizer';
import { buildProjectedPartShapeFromRasterData } from './partAssembler';

const projectPointDepth = (
    projectionCache: MeshProjectionCache,
    vertexIndex: number,
): number => projectionCache.depth[vertexIndex];

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
            part.triangleCount >= settings.minTriangleCount &&
            (visibleLeafIds ? visibleLeafIds.has(part.leafId) : true),
    );
    if (filteredParts.length === 0) {
        return {
            shapes: [],
            depthAtlas: null as GpuDepthAtlasState | null,
        };
    }

    const rasterizer = getGpuPartRasterizer();
    const prepareStart = performance.now();
    const preparedParts = filteredParts
        .map((part) => {
            const projectionCache = frame.getProjectionCache(part.mesh);
            if (!projectionCache) {
                return null;
            }

            const fallbackDepth =
                part.triangles[0]?.vertexIndices !== undefined
                    ? (projectPointDepth(projectionCache, part.triangles[0].vertexIndices[0]) +
                          projectPointDepth(projectionCache, part.triangles[0].vertexIndices[1]) +
                          projectPointDepth(projectionCache, part.triangles[0].vertexIndices[2])) /
                      3
                    : Number.POSITIVE_INFINITY;

            return {
                part,
                projectionCache,
                fallbackDepth,
            };
        })
        .filter(
            (
                preparedPart,
            ): preparedPart is {
                part: ProjectionPartSource;
                projectionCache: MeshProjectionCache;
                fallbackDepth: number;
            } => preparedPart !== null,
        );
    const prepareMs = performance.now() - prepareStart;

    const rasterStart = performance.now();
    const rasterResults = await rasterizer.rasterizeBatch(preparedParts);
    const rasterMs = performance.now() - rasterStart;
    const depthAtlas = rasterizer.getDepthAtlasState();

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
        .sort((left, right) => right.depth - left.depth);
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
