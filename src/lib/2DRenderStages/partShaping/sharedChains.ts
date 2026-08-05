import type { ProjectionPartSource } from '../../modelParts';
import { simplifyOpenPolyline } from '../../2DRenderShared/geometry';
import type {
    MaskBounds,
    MeshProjectionCache,
    Point2D,
    ProjectedSharedChain,
    ProjectionMaskState,
} from '../../2DRenderShared/types';

const rasterizeSegmentToMask = (
    start: Point2D,
    end: Point2D,
    bounds: MaskBounds,
    target: Uint8Array,
) => {
    const localStartX = start.x - bounds.offsetX;
    const localStartY = start.y - bounds.offsetY;
    const localEndX = end.x - bounds.offsetX;
    const localEndY = end.y - bounds.offsetY;
    const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(localEndX - localStartX), Math.abs(localEndY - localStartY))),
    );

    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = Math.round(localStartX + (localEndX - localStartX) * t);
        const y = Math.round(localStartY + (localEndY - localStartY) * t);

        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                const px = x + offsetX;
                const py = y + offsetY;
                if (px < 0 || py < 0 || px >= bounds.width || py >= bounds.height) {
                    continue;
                }
                target[py * bounds.width + px] = 1;
            }
        }
    }
};

const projectVertexToScreenCached = (
    cache: MeshProjectionCache,
    vertexIndex: number,
): Point2D => ({
    x: cache.screenX[vertexIndex],
    y: cache.screenY[vertexIndex],
});

const simplifySegmentWithAnchors = (points: Point2D[], epsilon: number) => {
    if (points.length <= 2) {
        return points;
    }

    const simplified = simplifyOpenPolyline(points, epsilon);
    if (simplified.length < 2) {
        return [points[0], points[points.length - 1]];
    }
    return simplified;
};

export const buildProjectedSharedChainsForPart = (
    part: ProjectionPartSource,
    leafId: string,
    state: ProjectionMaskState,
    projectionCache: MeshProjectionCache,
    bounds: MaskBounds,
    epsilon: number,
) => {
    const mask = new Uint8Array(bounds.width * bounds.height);
    const chains: ProjectedSharedChain[] = [];

    state.sharedChains.forEach((chain) => {
        if (chain.mesh !== part.mesh) {
            return;
        }

        if (chain.leafIds[0] !== leafId && chain.leafIds[1] !== leafId) {
            return;
        }

        const originalPoints = chain.vertexIndices.map((vertexIndex) =>
            projectVertexToScreenCached(projectionCache, vertexIndex),
        );
        if (originalPoints.length < 2) {
            return;
        }

        for (let index = 0; index < originalPoints.length - 1; index += 1) {
            rasterizeSegmentToMask(originalPoints[index], originalPoints[index + 1], bounds, mask);
        }

        chains.push({
            id: chain.id,
            originalPoints,
            simplifiedPoints: simplifySegmentWithAnchors(originalPoints, epsilon),
        });
    });

    return {
        mask,
        chains,
    };
};
