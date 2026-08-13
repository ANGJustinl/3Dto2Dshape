import type { Point2D } from '../../2DRenderShared/types';

/**
 * Extract polygon loops from a binary mask using run-length boundary edges.
 *
 * The previous implementation emitted one edge for every occupied pixel
 * side. A 700-part MMD frame can therefore create hundreds of thousands of
 * short edges before simplification. We emit maximal horizontal/vertical
 * runs instead, preserving the same cell-accurate boundary while reducing
 * edge count and traversal work substantially.
 */
export const extractLoopsFromMask = (
    occupied: Uint8Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
) => {
    if (width <= 0 || height <= 0 || occupied.length < width * height) {
        return [];
    }

    const vertexStride = width + 1;
    const vertexId = (x: number, y: number) => y * vertexStride + x;
    const edgeStarts: number[] = [];
    const edgeEnds: number[] = [];
    const outgoing = new Map<number, number[]>();

    const addEdge = (start: number, end: number) => {
        const edgeId = edgeStarts.length;
        edgeStarts.push(start);
        edgeEnds.push(end);
        const edges = outgoing.get(start);
        if (edges) {
            edges.push(edgeId);
        } else {
            outgoing.set(start, [edgeId]);
        }
    };

    const isOccupied = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height && occupied[y * width + x] !== 0;

    // Horizontal boundary runs: top edges go left-to-right; bottom edges go
    // right-to-left so all loops retain the original winding convention.
    for (let y = 0; y < height; y += 1) {
        let x = 0;
        while (x < width) {
            if (!isOccupied(x, y)) {
                x += 1;
                continue;
            }

            const topBoundary = !isOccupied(x, y - 1);
            const bottomBoundary = !isOccupied(x, y + 1);
            const startX = x;
            let endX = x + 1;
            while (
                endX < width &&
                isOccupied(endX, y) &&
                (!isOccupied(endX, y - 1) === topBoundary) &&
                (!isOccupied(endX, y + 1) === bottomBoundary)
            ) {
                endX += 1;
            }

            if (topBoundary) {
                addEdge(vertexId(startX, y), vertexId(endX, y));
            }
            if (bottomBoundary) {
                addEdge(vertexId(endX, y + 1), vertexId(startX, y + 1));
            }
            x = endX;
        }
    }

    // Vertical boundary runs: right edges go top-to-bottom; left edges go
    // bottom-to-top to close the clockwise/counter-clockwise loops.
    for (let x = 0; x < width; x += 1) {
        let y = 0;
        while (y < height) {
            if (!isOccupied(x, y)) {
                y += 1;
                continue;
            }

            const leftBoundary = !isOccupied(x - 1, y);
            const rightBoundary = !isOccupied(x + 1, y);
            const startY = y;
            let endY = y + 1;
            while (
                endY < height &&
                isOccupied(x, endY) &&
                (!isOccupied(x - 1, endY) === leftBoundary) &&
                (!isOccupied(x + 1, endY) === rightBoundary)
            ) {
                endY += 1;
            }

            if (rightBoundary) {
                addEdge(vertexId(x + 1, startY), vertexId(x + 1, endY));
            }
            if (leftBoundary) {
                addEdge(vertexId(x, endY), vertexId(x, startY));
            }
            y = endY;
        }
    }

    const visitedEdges = new Uint8Array(edgeStarts.length);
    const pointFromId = (id: number): Point2D => ({
        x: offsetX + (id % vertexStride),
        y: offsetY + Math.floor(id / vertexStride),
    });
    const loops: Point2D[][] = [];

    for (let initialEdge = 0; initialEdge < edgeStarts.length; initialEdge += 1) {
        if (visitedEdges[initialEdge] !== 0) {
            continue;
        }

        const start = edgeStarts[initialEdge];
        const loopIds: number[] = [start];
        let current = start;
        let edgeId = initialEdge;
        let guard = 0;

        while (guard < edgeStarts.length * 2) {
            guard += 1;
            visitedEdges[edgeId] = 1;
            current = edgeEnds[edgeId];
            if (current === start) {
                break;
            }

            loopIds.push(current);
            const candidates = outgoing.get(current) ?? [];
            const nextEdge = candidates.find((candidate) => visitedEdges[candidate] === 0);
            if (nextEdge === undefined) {
                break;
            }
            edgeId = nextEdge;
        }

        if (loopIds.length >= 3 && current === start) {
            loops.push(loopIds.map(pointFromId));
        }
    }

    return loops;
};
