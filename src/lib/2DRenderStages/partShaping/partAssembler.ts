import type { GpuRasterizedPartData } from '../partRasterization/rasterizer';
import type { ProjectionPartSource } from '../../modelParts';
import { polygonArea } from '../../2DRenderShared/geometry';
import type {
    MeshProjectionCache,
    ProjectedPartShape,
    ProjectionMaskState,
    ProjectionOverlaySettings,
} from '../../2DRenderShared/types';
import { buildProjectedSharedChainsForPart } from './sharedChains';
import { collectContourAnchorIndices, simplifyLoopByAnchorIndices } from './contourSimplification';
import { extractLoopsFromMask } from './contourExtraction';

export const buildProjectedPartShapeFromRasterData = (
    part: ProjectionPartSource,
    state: ProjectionMaskState,
    projectionCache: MeshProjectionCache,
    settings: ProjectionOverlaySettings,
    rasterData: GpuRasterizedPartData,
) => {
    const sharedChainsStart = performance.now();
    const projectedSharedChains = buildProjectedSharedChainsForPart(
        part,
        part.leafId,
        state,
        projectionCache,
        {
            width: rasterData.width,
            height: rasterData.height,
            offsetX: rasterData.offsetX,
            offsetY: rasterData.offsetY,
        },
        settings.simplifyEpsilon,
    );
    const buildSharedChainsMs = performance.now() - sharedChainsStart;

    const extractLoopsStart = performance.now();
    const extractedLoops = extractLoopsFromMask(
        rasterData.occupied,
        rasterData.width,
        rasterData.height,
        rasterData.offsetX,
        rasterData.offsetY,
    );
    const extractLoopsMs = performance.now() - extractLoopsStart;

    const simplifyLoopsStart = performance.now();
    const loops = extractedLoops
        .map((loop) => {
            const anchorIndices = collectContourAnchorIndices(
                loop,
                projectedSharedChains.mask,
                rasterData.width,
                rasterData.height,
                rasterData.offsetX,
                rasterData.offsetY,
            );

            return simplifyLoopByAnchorIndices(
                loop,
                anchorIndices,
                settings.simplifyEpsilon,
                projectedSharedChains.mask,
                projectedSharedChains.chains,
                rasterData.width,
                rasterData.height,
                rasterData.offsetX,
                rasterData.offsetY,
            );
        })
        .filter((loop) => loop.length >= 3 && Math.abs(polygonArea(loop)) > 6);
    const simplifyLoopsMs = performance.now() - simplifyLoopsStart;

    if (loops.length === 0) {
        return {
            shape: null,
            timings: {
                buildSharedChains: buildSharedChainsMs,
                extractLoops: extractLoopsMs,
                simplifyLoops: simplifyLoopsMs,
                finalizeShape: 0,
            },
        };
    }

    const finalizeShapeStart = performance.now();
    const shape = {
        leafId: part.leafId,
        color: part.color,
        depth: rasterData.nearestDepth,
        loops,
        rasterBounds: {
            width: rasterData.width,
            height: rasterData.height,
            offsetX: rasterData.offsetX,
            offsetY: rasterData.offsetY,
        },
        atlasRegion: {
            atlasX: rasterData.atlasX,
            atlasY: rasterData.atlasY,
            atlasWidth: rasterData.atlasWidth,
            atlasHeight: rasterData.atlasHeight,
        },
        orientedBounds: rasterData.orientedBounds,
    } satisfies ProjectedPartShape;
    const finalizeShapeMs = performance.now() - finalizeShapeStart;

    return {
        shape,
        timings: {
            buildSharedChains: buildSharedChainsMs,
            extractLoops: extractLoopsMs,
            simplifyLoops: simplifyLoopsMs,
            finalizeShape: finalizeShapeMs,
        },
    };
};
