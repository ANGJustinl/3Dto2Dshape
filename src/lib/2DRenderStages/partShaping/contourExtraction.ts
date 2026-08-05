import type { Point2D } from '../../2DRenderShared/types';

export const extractLoopsFromMask = (
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
