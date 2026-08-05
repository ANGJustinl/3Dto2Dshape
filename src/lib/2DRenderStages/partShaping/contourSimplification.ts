import {
    distanceBetweenPoints,
    distanceToSegment,
    simplifyOpenPolyline,
} from '../../2DRenderShared/geometry';
import type { Point2D, ProjectedSharedChain } from '../../2DRenderShared/types';

const simplifyClosedPolyline = (points: Point2D[], epsilon: number) => {
    if (points.length <= 3 || epsilon <= 0) {
        return points;
    }

    const open = [...points, points[0]];
    const simplified = simplifyOpenPolyline(open, epsilon).slice(0, -1);
    return simplified.length >= 3 ? simplified : points;
};

const getLoopSegment = (loop: Point2D[], startIndex: number, endIndex: number) => {
    if (startIndex <= endIndex) {
        return loop.slice(startIndex, endIndex + 1);
    }
    return [...loop.slice(startIndex), ...loop.slice(0, endIndex + 1)];
};

export const collectContourAnchorIndices = (
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

export const simplifyLoopByAnchorIndices = (
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
            : simplifyOpenPolyline(segment, epsilon);
        if (index === 0) {
            result.push(...simplified);
        } else {
            result.push(...simplified.slice(1));
        }
    }

    return result.length >= 3 ? result : simplifyClosedPolyline(loop, epsilon);
};
