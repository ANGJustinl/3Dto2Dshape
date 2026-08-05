import type { Point2D } from './types';

export const distanceToSegment = (point: Point2D, start: Point2D, end: Point2D) => {
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

export const distanceBetweenPoints = (left: Point2D, right: Point2D) =>
    Math.hypot(left.x - right.x, left.y - right.y);

export const simplifyOpenPolyline = (points: Point2D[], epsilon: number): Point2D[] => {
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

export const polygonArea = (points: Point2D[]) => {
    let sum = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        sum += current.x * next.y - next.x * current.y;
    }
    return sum * 0.5;
};
