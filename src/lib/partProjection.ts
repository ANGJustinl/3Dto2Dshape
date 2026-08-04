import * as THREE from 'three';
import { getGpuPartRasterizer, type GpuRasterizedPartData } from './gpuPartRasterizer';
import type { ProjectionPartSource, ProjectionSharedChain } from './modelParts';
import { recordPerfSample } from './perfLogger';
import type { ProjectionFrameResult } from './webgpuScreenProjector';

export type ProjectionOverlaySettings = {
    enabled: boolean;
    simplifyEpsilon: number;
    strokeWidth: number;
    showContours: boolean;
    opacity: number;
    minTriangleCount: number;
};

export type ProjectedPartShape = {
    leafId: string;
    color: string;
    depth: number;
    loops: Array<Array<{ x: number; y: number }>>;
    depthField: {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        values: Float32Array;
    };
    coverageMask: {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        values: Uint8Array;
    };
};

const MIN_RENDERED_PART_SCREEN_AREA = 48;

export type ProjectionMaskState = {
    sharedChains: ProjectionSharedChain[];
};

type Point2D = { x: number; y: number };
type MaskBounds = {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
};
type ProjectedSharedChain = {
    id: string;
    originalPoints: Point2D[];
    simplifiedPoints: Point2D[];
};
export type MeshProjectionCache = {
    width: number;
    height: number;
    screenX: Float32Array;
    screenY: Float32Array;
    depth: Float32Array;
};

const distanceToSegment = (point: Point2D, start: Point2D, end: Point2D) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
        return Math.hypot(point.x - start.x, point.y - start.y);
    }

    const t = Math.max(
        0,
        Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
    );
    const projectedX = start.x + dx * t;
    const projectedY = start.y + dy * t;
    return Math.hypot(point.x - projectedX, point.y - projectedY);
};

const distanceBetweenPoints = (left: Point2D, right: Point2D) =>
    Math.hypot(left.x - right.x, left.y - right.y);

const simplifyOpenPolyline = (points: Point2D[], epsilon: number): Point2D[] => {
    if (points.length <= 2 || epsilon <= 0) {
        return points;
    }

    let maxDistance = 0;
    let splitIndex = -1;
    for (let index = 1; index < points.length - 1; index += 1) {
        const distance = distanceToSegment(points[index], points[0], points[points.length - 1]);
        if (distance > maxDistance) {
            maxDistance = distance;
            splitIndex = index;
        }
    }

    if (maxDistance <= epsilon || splitIndex === -1) {
        return [points[0], points[points.length - 1]];
    }

    const left = simplifyOpenPolyline(points.slice(0, splitIndex + 1), epsilon);
    const right = simplifyOpenPolyline(points.slice(splitIndex), epsilon);
    return [...left.slice(0, -1), ...right];
};

const polygonArea = (points: Point2D[]) => {
    let sum = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        sum += current.x * next.y - next.x * current.y;
    }
    return sum * 0.5;
};

const getLoopScreenArea = (loop: Point2D[]) => Math.abs(polygonArea(loop));

export const filterSmallProjectedPartShapes = (shapes: ProjectedPartShape[]) =>
    shapes
        .map((shape) => ({
            ...shape,
            loops: shape.loops.filter((loop) => getLoopScreenArea(loop) >= MIN_RENDERED_PART_SCREEN_AREA),
        }))
        .filter((shape) => shape.loops.length > 0);

const simplifyClosedPolyline = (points: Point2D[], epsilon: number) => {
    if (points.length <= 3 || epsilon <= 0) {
        return points;
    }

    const open = [...points, points[0]];
    const simplified = simplifyOpenPolyline(open, epsilon).slice(0, -1);
    return simplified.length >= 3 ? simplified : points;
};

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


const buildProjectedSharedChainsForPart = (
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

const getLoopSegment = (loop: Point2D[], startIndex: number, endIndex: number) => {
    if (startIndex <= endIndex) {
        return loop.slice(startIndex, endIndex + 1);
    }
    return [...loop.slice(startIndex), ...loop.slice(0, endIndex + 1)];
};

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

const collectContourAnchorIndices = (
    loop: Point2D[],
    constraintMask: Uint8Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
) => {
    const anchors: number[] = [];
    const isInside = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height;
    const isConstraint = (x: number, y: number) =>
        isInside(x, y) && constraintMask[y * width + x] === 1;
    const touchesConstraint = (x: number, y: number) =>
        isConstraint(x, y) ||
        isConstraint(x - 1, y) ||
        isConstraint(x + 1, y) ||
        isConstraint(x, y - 1) ||
        isConstraint(x, y + 1);

    loop.forEach((point, index) => {
        const localX = Math.floor(point.x - offsetX);
        const localY = Math.floor(point.y - offsetY);
        if (
            touchesConstraint(localX, localY) ||
            touchesConstraint(localX - 1, localY) ||
            touchesConstraint(localX, localY - 1) ||
            touchesConstraint(localX - 1, localY - 1)
        ) {
            anchors.push(index);
        }
    });

    if (anchors.length === 0) {
        return anchors;
    }

    const deduped = anchors.filter((anchor, index, array) => {
        if (index === 0) {
            return true;
        }
        return anchor - array[index - 1] > 2;
    });

    if (deduped.length > 1 && loop.length - deduped[deduped.length - 1] + deduped[0] <= 2) {
        deduped.shift();
    }

    return deduped;
};

const isSegmentConstraintDriven = (
    segment: Point2D[],
    constraintMask: Uint8Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
) => {
    let hits = 0;
    for (const point of segment) {
        const localX = Math.floor(point.x - offsetX);
        const localY = Math.floor(point.y - offsetY);
        for (let sampleOffsetY = -1; sampleOffsetY <= 1; sampleOffsetY += 1) {
            for (let sampleOffsetX = -1; sampleOffsetX <= 1; sampleOffsetX += 1) {
                const x = localX + sampleOffsetX;
                const y = localY + sampleOffsetY;
                if (x < 0 || y < 0 || x >= width || y >= height) {
                    continue;
                }
                if (constraintMask[y * width + x] === 1) {
                    hits += 1;
                    break;
                }
            }
            if (hits > 0) {
                break;
            }
        }
    }

    return hits > 0;
};

const scoreSegmentAgainstPolyline = (segment: Point2D[], polyline: Point2D[]) => {
    if (segment.length === 0 || polyline.length < 2) {
        return Number.POSITIVE_INFINITY;
    }

    let totalDistance = 0;
    segment.forEach((point) => {
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < polyline.length - 1; index += 1) {
            bestDistance = Math.min(
                bestDistance,
                distanceToSegment(point, polyline[index], polyline[index + 1]),
            );
        }
        totalDistance += bestDistance;
    });

    return totalDistance / segment.length;
};

const matchSharedChainToSegment = (
    segment: Point2D[],
    sharedChains: ProjectedSharedChain[],
) => {
    if (segment.length < 2) {
        return null;
    }

    const segmentStart = segment[0];
    const segmentEnd = segment[segment.length - 1];
    let bestMatch: { points: Point2D[]; score: number } | null = null;

    sharedChains.forEach((chain) => {
        const forwardStartDistance = distanceBetweenPoints(segmentStart, chain.originalPoints[0]);
        const forwardEndDistance = distanceBetweenPoints(
            segmentEnd,
            chain.originalPoints[chain.originalPoints.length - 1],
        );
        const reverseStartDistance = distanceBetweenPoints(
            segmentStart,
            chain.originalPoints[chain.originalPoints.length - 1],
        );
        const reverseEndDistance = distanceBetweenPoints(segmentEnd, chain.originalPoints[0]);

        const endpointThreshold = 8;
        const candidates: Point2D[][] = [];
        if (forwardStartDistance <= endpointThreshold && forwardEndDistance <= endpointThreshold) {
            candidates.push(chain.simplifiedPoints);
        }
        if (reverseStartDistance <= endpointThreshold && reverseEndDistance <= endpointThreshold) {
            candidates.push([...chain.simplifiedPoints].reverse());
        }

        candidates.forEach((candidate) => {
            const score = scoreSegmentAgainstPolyline(segment, candidate);
            if (!bestMatch || score < bestMatch.score) {
                bestMatch = {
                    points: candidate,
                    score,
                };
            }
        });
    });

    if (!bestMatch || bestMatch.score > 4) {
        return null;
    }

    return bestMatch.points;
};

const simplifyLoopByAnchorIndices = (
    loop: Point2D[],
    anchorIndices: number[],
    epsilon: number,
    constraintMask: Uint8Array,
    sharedChains: ProjectedSharedChain[],
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
) => {
    if (anchorIndices.length < 2) {
        return simplifyClosedPolyline(loop, epsilon);
    }

    const sortedAnchors = [...anchorIndices].sort((left, right) => left - right);
    const result: Point2D[] = [];
    for (let index = 0; index < sortedAnchors.length; index += 1) {
        const startIndex = sortedAnchors[index];
        const endIndex = sortedAnchors[(index + 1) % sortedAnchors.length];
        const segment = getLoopSegment(loop, startIndex, endIndex);
        const simplified = isSegmentConstraintDriven(
            segment,
            constraintMask,
            width,
            height,
            offsetX,
            offsetY,
        )
            ? matchSharedChainToSegment(segment, sharedChains) ?? segment
            : simplifySegmentWithAnchors(segment, epsilon);
        if (index === 0) {
            result.push(...simplified);
        } else {
            result.push(...simplified.slice(1));
        }
    }

    return result.length >= 3 ? result : simplifyClosedPolyline(loop, epsilon);
};

const extractLoopsFromMask = (
    occupied: Uint8Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
) => {
    const boundaryEdges = new Map<string, [Point2D, Point2D]>();
    const indexOf = (x: number, y: number) => y * width + x;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (occupied[indexOf(x, y)] === 0) {
                continue;
            }

            const leftEmpty = x === 0 || occupied[indexOf(x - 1, y)] === 0;
            const rightEmpty = x === width - 1 || occupied[indexOf(x + 1, y)] === 0;
            const topEmpty = y === 0 || occupied[indexOf(x, y - 1)] === 0;
            const bottomEmpty = y === height - 1 || occupied[indexOf(x, y + 1)] === 0;

            if (topEmpty) {
                boundaryEdges.set(`h:${x},${y}`, [
                    { x: offsetX + x, y: offsetY + y },
                    { x: offsetX + x + 1, y: offsetY + y },
                ]);
            }
            if (rightEmpty) {
                boundaryEdges.set(`v:${x + 1},${y}`, [
                    { x: offsetX + x + 1, y: offsetY + y },
                    { x: offsetX + x + 1, y: offsetY + y + 1 },
                ]);
            }
            if (bottomEmpty) {
                boundaryEdges.set(`h:${x},${y + 1}`, [
                    { x: offsetX + x + 1, y: offsetY + y + 1 },
                    { x: offsetX + x, y: offsetY + y + 1 },
                ]);
            }
            if (leftEmpty) {
                boundaryEdges.set(`v:${x},${y}`, [
                    { x: offsetX + x, y: offsetY + y + 1 },
                    { x: offsetX + x, y: offsetY + y },
                ]);
            }
        }
    }

    const adjacency = new Map<string, Point2D[]>();
    const pointKey = (point: Point2D) => `${point.x},${point.y}`;
    boundaryEdges.forEach(([start, end]) => {
        const startNeighbors = adjacency.get(pointKey(start)) ?? [];
        startNeighbors.push(end);
        adjacency.set(pointKey(start), startNeighbors);
    });

    const visitedEdges = new Set<string>();
    const edgeKey = (start: Point2D, end: Point2D) => `${pointKey(start)}>${pointKey(end)}`;
    const loops: Point2D[][] = [];

    boundaryEdges.forEach(([start, end]) => {
        const initialKey = edgeKey(start, end);
        if (visitedEdges.has(initialKey)) {
            return;
        }

        const loop: Point2D[] = [start];
        let current = start;
        let next = end;
        let guard = 0;

        while (guard < boundaryEdges.size * 2) {
            guard += 1;
            visitedEdges.add(edgeKey(current, next));
            current = next;
            if (pointKey(current) === pointKey(start)) {
                break;
            }

            loop.push(current);
            const candidates = adjacency.get(pointKey(current)) ?? [];
            const candidate = candidates.find((point) => !visitedEdges.has(edgeKey(current, point)));
            if (!candidate) {
                break;
            }
            next = candidate;
        }

        if (loop.length >= 3 && pointKey(current) === pointKey(start)) {
            loops.push(loop);
        }
    });

    return loops;
};

const projectPointDepth = (
    projectionCache: MeshProjectionCache,
    vertexIndex: number,
): number => projectionCache.depth[vertexIndex];

const buildProjectedPartShapeFromRasterData = (
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
        depthField: {
            width: rasterData.width,
            height: rasterData.height,
            offsetX: rasterData.offsetX,
            offsetY: rasterData.offsetY,
            values: rasterData.depthValues,
        },
        coverageMask: {
            width: rasterData.width,
            height: rasterData.height,
            offsetX: rasterData.offsetX,
            offsetY: rasterData.offsetY,
            values: rasterData.occupied,
        },
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

export const createProjectionMaskState = (
    _root: THREE.Object3D,
    _leafMaterialMap: Map<string, THREE.Material>,
    _parts: ProjectionPartSource[],
    sharedChains: ProjectionSharedChain[],
) => {
    return {
        sharedChains,
    } satisfies ProjectionMaskState;
};

export const collectProjectedPartShapesForGpuFrame = async (
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
        return [];
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
        .filter((part): part is ProjectedPartShape => part !== null)
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

    return shapes;
};
