export type Point2D = {
    x: number;
    y: number;
};

export type OrientedBounds2D = {
    center: Point2D;
    axisX: Point2D;
    axisY: Point2D;
    extentX: number;
    extentY: number;
};

const cross = (origin: Point2D, left: Point2D, right: Point2D) =>
    (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);

const dot = (left: Point2D, right: Point2D) => left.x * right.x + left.y * right.y;

const normalize = (vector: Point2D): Point2D => {
    const length = Math.hypot(vector.x, vector.y);
    if (length <= 1e-6) {
        return { x: 1, y: 0 };
    }

    return {
        x: vector.x / length,
        y: vector.y / length,
    };
};

const subtract = (left: Point2D, right: Point2D): Point2D => ({
    x: left.x - right.x,
    y: left.y - right.y,
});

const convexHull = (points: Point2D[]) => {
    if (points.length <= 1) {
        return points;
    }

    const sorted = [...points].sort((left, right) =>
        left.x === right.x ? left.y - right.y : left.x - right.x,
    );

    const lower: Point2D[] = [];
    sorted.forEach((point) => {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    });

    const upper: Point2D[] = [];
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
        const point = sorted[index];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    return [...lower, ...upper];
};

const dedupePoints = (points: Point2D[]) => {
    const unique = new Map<string, Point2D>();
    points.forEach((point) => {
        const key = `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
        if (!unique.has(key)) {
            unique.set(key, point);
        }
    });
    return [...unique.values()];
};

export const computeOrientedBounds2D = (points: Point2D[]): OrientedBounds2D | null => {
    const uniquePoints = dedupePoints(points);
    if (uniquePoints.length === 0) {
        return null;
    }

    if (uniquePoints.length === 1) {
        return {
            center: uniquePoints[0],
            axisX: { x: 1, y: 0 },
            axisY: { x: 0, y: 1 },
            extentX: 0.5,
            extentY: 0.5,
        };
    }

    const hull = convexHull(uniquePoints);
    if (hull.length === 0) {
        return null;
    }

    let bestBounds: OrientedBounds2D | null = null;
    let bestArea = Number.POSITIVE_INFINITY;

    for (let index = 0; index < hull.length; index += 1) {
        const current = hull[index];
        const next = hull[(index + 1) % hull.length];
        const axisX = normalize(subtract(next, current));
        const axisY = { x: -axisX.y, y: axisX.x };

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        hull.forEach((point) => {
            const projectedX = dot(point, axisX);
            const projectedY = dot(point, axisY);
            minX = Math.min(minX, projectedX);
            maxX = Math.max(maxX, projectedX);
            minY = Math.min(minY, projectedY);
            maxY = Math.max(maxY, projectedY);
        });

        const extentX = (maxX - minX) * 0.5;
        const extentY = (maxY - minY) * 0.5;
        const area = extentX * extentY;
        if (area >= bestArea) {
            continue;
        }

        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        bestArea = area;
        bestBounds = {
            center: {
                x: axisX.x * centerX + axisY.x * centerY,
                y: axisX.y * centerX + axisY.y * centerY,
            },
            axisX,
            axisY,
            extentX: Math.max(extentX, 0.5),
            extentY: Math.max(extentY, 0.5),
        };
    }

    return bestBounds;
};
