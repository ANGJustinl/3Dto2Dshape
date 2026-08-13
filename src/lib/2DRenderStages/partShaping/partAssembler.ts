import * as THREE from 'three';
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
import { perturbPaintLoop } from '../../2DRenderShared/paintStyle';
import { getStyleModeDefaults } from '../../2DRenderShared/focusResolver';

export const buildProjectedPartShapeFromRasterData = (
    part: ProjectionPartSource,
    state: ProjectionMaskState,
    projectionCache: MeshProjectionCache,
    settings: ProjectionOverlaySettings,
    rasterData: GpuRasterizedPartData,
) => {
    const modeDefaults = getStyleModeDefaults(settings.styleMode);
    const simplifyMultiplier = settings.enableComposition ? part.simplifyMultiplier ?? 1 : 1;
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

            const simplified = simplifyLoopByAnchorIndices(
                loop,
                anchorIndices,
                settings.simplifyEpsilon * simplifyMultiplier,
                projectedSharedChains.mask,
                projectedSharedChains.chains,
                rasterData.width,
                rasterData.height,
                rasterData.offsetX,
                rasterData.offsetY,
            );

            const seed = [...part.leafId].reduce(
                (total, character) => total + character.charCodeAt(0),
                0,
            );
            return perturbPaintLoop(
                simplified,
                settings.enableEdgeDistortion && projectedSharedChains.chains.length === 0
                    ? settings.edgeRoughness * modeDefaults.edgeRoughnessScale
                    : 0,
                seed,
            );
        })
        .filter(
            (loop) =>
                loop.length >= 3 &&
                Math.abs(polygonArea(loop)) > (part.focusLevel === 'focal' ? 0.12 : 6),
        );
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
    const area = loops.reduce((total, loop) => total + Math.abs(polygonArea(loop)), 0);
    const points = loops.flat();
    const centroid = points.length > 0
        ? points.reduce(
              (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
              { x: 0, y: 0 },
          )
        : { x: 0, y: 0 };
    if (points.length > 0) {
        centroid.x /= points.length;
        centroid.y /= points.length;
    }
    const focusLevel = part.focusLevel ?? 'support';
    const edgeMode =
        focusLevel === 'focal'
            ? 'hard'
            : settings.edgeSmoothing === 'open'
              ? 'open'
              : settings.edgeSmoothing;
    const stableSeed = [...part.leafId].reduce(
        (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
        17,
    );
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = Number.NEGATIVE_INFINITY;
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    const left = new THREE.Vector3();
    const middle = new THREE.Vector3();
    const right = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const normal = new THREE.Vector3();

    part.triangles.forEach((triangle) => {
        const [a, b, c] = triangle.vertexIndices;
        minDepth = Math.min(minDepth, projectionCache.depth[a], projectionCache.depth[b], projectionCache.depth[c]);
        maxDepth = Math.max(maxDepth, projectionCache.depth[a], projectionCache.depth[b], projectionCache.depth[c]);

        left.set(projectionCache.worldX[a], projectionCache.worldY[a], projectionCache.worldZ[a]);
        middle.set(projectionCache.worldX[b], projectionCache.worldY[b], projectionCache.worldZ[b]);
        right.set(projectionCache.worldX[c], projectionCache.worldY[c], projectionCache.worldZ[c]);

        edge1.copy(middle).sub(left);
        edge2.copy(right).sub(left);
        normal.copy(edge1).cross(edge2).normalize();

        normalX += normal.x;
        normalY += normal.y;
        normalZ += normal.z;
    });
    const averagedNormal = new THREE.Vector3(normalX, normalY, normalZ).normalize();
    const shape = {
        leafId: part.leafId,
        sourceLeafId: part.sourceLeafId ?? part.leafId,
        paintLayer: part.paintLayer ?? 'base',
        stableId: `${part.sourceLeafId ?? part.leafId}::${part.paintLayer ?? 'base'}::${Math.round(centroid.x / 4)}:${Math.round(centroid.y / 4)}`,
        focusLevel,
        macroGroup: part.macroGroup ?? 'other',
        accentScore: part.accentScore,
        connectivityRole: part.connectivityRole,
        edgeProfile: {
            mode: edgeMode,
            hardness: focusLevel === 'focal' ? 0.95 : focusLevel === 'abstract' ? 0.3 : 0.62,
            openness: edgeMode === 'open' ? (focusLevel === 'abstract' ? 0.32 : 0.16) : 0,
            seed: stableSeed,
        },
        sourceColors: [part.color],
        color: part.color,
        depth: rasterData.nearestDepth,
        area,
        centroid,
        depthRange: [
            Number.isFinite(minDepth) ? minDepth : rasterData.nearestDepth,
            Number.isFinite(maxDepth) ? maxDepth : rasterData.nearestDepth,
        ],
        normal: [averagedNormal.x, averagedNormal.y, averagedNormal.z],
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
