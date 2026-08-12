import type { ProjectionSharedChain } from '../../modelParts';
import { extractLoopsFromMask } from './contourExtraction';
import { colorDistanceHex, medoidHexColor } from '../../2DRenderShared/paintStyle';
import { getStyleModeDefaults } from '../../2DRenderShared/focusResolver';
import type {
    FocusLevel,
    MacroGroup,
    ProjectedPartShape,
    ProjectionOverlaySettings,
} from '../../2DRenderShared/types';
import * as polygonClippingNamespace from 'polygon-clipping';

const polygonClipping = (
    (polygonClippingNamespace as unknown as { default?: { union: (...geometries: unknown[]) => unknown } }).default ??
    (polygonClippingNamespace as unknown as { union: (...geometries: unknown[]) => unknown })
);

type PolygonRing = Array<[number, number]>;
type MultiPolygon = PolygonRing[][];

type GroupState = {
    root: number;
    members: number[];
    cells: number[];
    focusLevel: Exclude<FocusLevel, 'auto'>;
    macroGroup: MacroGroup;
    paintLayer: ProjectedPartShape['paintLayer'];
    area: number;
    accentScore: number;
    connectivityRole: ProjectedPartShape['connectivityRole'];
};

const focusRank: Record<Exclude<FocusLevel, 'auto'>, number> = {
    abstract: 0,
    support: 1,
    focal: 2,
};

const isPointInsideShape = (shape: ProjectedPartShape, x: number, y: number) => {
    let parity = 0;
    shape.loops.forEach((loop) => {
        for (let index = 0; index < loop.length; index += 1) {
            const current = loop[index];
            const previous = loop[(index + loop.length - 1) % loop.length];
            const crosses = (current.y > y) !== (previous.y > y);
            if (!crosses) {
                continue;
            }
            const intersectionX =
                ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x;
            if (intersectionX > x) {
                parity ^= 1;
            }
        }
    });
    return parity === 1;
};

const createUnionFind = (count: number) => {
    const parents = Array.from({ length: count }, (_, index) => index);
    const find = (value: number): number => {
        if (parents[value] === value) {
            return value;
        }
        parents[value] = find(parents[value]);
        return parents[value];
    };
    const union = (left: number, right: number) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) {
            parents[rightRoot] = leftRoot;
        }
    };
    return { find, union };
};

const getShapeBounds = (shape: ProjectedPartShape) => {
    const points = shape.loops.flat();
    if (points.length === 0) {
        return null;
    }
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
};

const boundsCanTouch = (
    left: ProjectedPartShape,
    right: ProjectedPartShape,
    tolerance: number,
) => {
    const leftBounds = getShapeBounds(left);
    const rightBounds = getShapeBounds(right);
    if (!leftBounds || !rightBounds) {
        return false;
    }
    return !(
        leftBounds.maxX + tolerance < rightBounds.minX ||
        rightBounds.maxX + tolerance < leftBounds.minX ||
        leftBounds.maxY + tolerance < rightBounds.minY ||
        rightBounds.maxY + tolerance < leftBounds.minY
    );
};

const hasBlockedSharedChain = (
    left: ProjectedPartShape,
    right: ProjectedPartShape,
    chains: ProjectionSharedChain[],
) =>
    chains.some(
        (chain) =>
            (chain.leafIds.includes(left.sourceLeafId) && chain.leafIds.includes(right.sourceLeafId)) ||
            (chain.leafIds.includes(left.leafId) && chain.leafIds.includes(right.leafId)),
    );

const canMergeShapes = (
    left: ProjectedPartShape,
    right: ProjectedPartShape,
    settings: ProjectionOverlaySettings,
    chains: ProjectionSharedChain[],
) => {
    if (left.paintLayer !== right.paintLayer) {
        return false;
    }
    // Cross-source depth is only safe when the caller explicitly asks for a
    // permissive outer-only merge. The default depth/normal guards keep source
    // parts isolated, preventing the face atlas from being replaced by a
    // rear-part constant-depth polygon.
    if (
        left.sourceLeafId !== right.sourceLeafId &&
        settings.boundaryGuard !== 'outer'
    ) {
        return false;
    }
    if (colorDistanceHex(left.color, right.color) > settings.mergeColorThreshold) {
        return false;
    }
    if (hasBlockedSharedChain(left, right, chains)) {
        return false;
    }
    // A composed vector shape currently carries one depth value for its whole
    // polygon.  Never merge a pair whose source depth is not compatible with
    // that representation: otherwise a foreground face can inherit the depth
    // of a rear hair/cloth shape and disappear behind one large polygon.
    const depthDelta = Math.max(
        Math.abs(left.depth - right.depth),
        Math.abs(left.depthRange[0] - right.depthRange[0]),
        Math.abs(left.depthRange[1] - right.depthRange[1]),
    );
    const normalDot = Math.max(
        -1,
        Math.min(
            1,
            left.normal[0] * right.normal[0] + left.normal[1] * right.normal[1] + left.normal[2] * right.normal[2],
        ),
    );
    const normalAngle = Math.acos(normalDot);
    if (
        (settings.boundaryGuard === 'outerDepthNormal' ||
            settings.boundaryGuard === 'outerDepthNormalGap' ||
            settings.boundaryGuard === 'depthNormal') &&
        (depthDelta > settings.depthMergeThreshold || normalAngle > settings.normalMergeThreshold)
    ) {
        return false;
    }
    // Focal shapes are visibility anchors (face, eyes, bangs and chest
    // accents). Keep their original raster/depth atlas instead of replacing
    // them with a union polygon. This is intentionally stricter than the
    // user-selectable boundary guard because losing the face is catastrophic
    // for recognition.
    if (left.focusLevel === 'focal' || right.focusLevel === 'focal') {
        return false;
    }
    if (
        (left.macroGroup === 'face' && right.macroGroup === 'hair') ||
        (left.macroGroup === 'hair' && right.macroGroup === 'face')
    ) {
        return false;
    }
    if (
        (left.macroGroup === 'face' && right.macroGroup !== 'face') ||
        (right.macroGroup === 'face' && left.macroGroup !== 'face')
    ) {
        return false;
    }
    if (
        left.macroGroup !== right.macroGroup &&
        (left.macroGroup !== 'other' || right.macroGroup !== 'other')
    ) {
        return false;
    }
    // Keep the major semantic masses separate.  A union is allowed within a
    // hair mass, torso mass, or lower mass, but not across those boundaries;
    // this preserves the negative spaces at the shoulders, waist, skirt and
    // legs even when their sampled colors happen to be close.
    const structuralGroups = new Set<MacroGroup>(['hair', 'torso', 'lowerMass']);
    if (
        structuralGroups.has(left.macroGroup) &&
        structuralGroups.has(right.macroGroup) &&
        left.macroGroup !== right.macroGroup
    ) {
        return false;
    }
    if (settings.boundaryGuard === 'outerDepthNormalGap' &&
        Math.hypot(left.centroid.x - right.centroid.x, left.centroid.y - right.centroid.y) > settings.gapMergeThreshold + 8) {
        return false;
    }
    return true;
};

const shapeToPolygon = (shape: ProjectedPartShape): MultiPolygon => {
    const rings = shape.loops
        .filter((loop) => loop.length >= 3)
        .map((loop) => {
            const ring = loop.map((point) => [point.x, point.y] as [number, number]);
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                ring.push([first[0], first[1]]);
            }
            return ring;
        });
    return rings.length > 0 ? [rings] : [];
};

const polygonToLoops = (polygon: MultiPolygon) =>
    polygon.flatMap((poly) =>
        poly.flatMap((ring) => {
            const points = ring.map(([x, y]) => ({ x, y }));
            if (points.length > 1) {
                const first = points[0];
                const last = points[points.length - 1];
                if (first.x === last.x && first.y === last.y) {
                    points.pop();
                }
            }
            return points.length >= 3 ? [points] : [];
        }),
    );

const makeFallbackMergedShape = (members: ProjectedPartShape[]) => {
    const loops = members.flatMap((shape) => shape.loops);
    return createMergedShape(members, loops);
};

const getUnionLoops = (members: ProjectedPartShape[]) => {
    const loops = unionVectorLoops(members);
    return loops.length > 0 ? loops : members.flatMap((shape) => shape.loops);
};

const createMergedShape = (
    members: ProjectedPartShape[],
    loops: Array<Array<{ x: number; y: number }>>,
) => {
    if (members.length === 0 || loops.length === 0) {
        return null;
    }
    const points = loops.flat();
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const sourceColors = [...new Set(members.flatMap((shape) => shape.sourceColors))];
    const representative = medoidHexColor(sourceColors.length > 0 ? sourceColors : members.map((shape) => shape.color));
    const nearest = members.reduce((best, shape) => (shape.depth < best.depth ? shape : best), members[0]);
    const accentScore = Math.max(...members.map((shape) => shape.accentScore ?? 0));
    const connectivityRole = members.some((shape) => shape.connectivityRole === 'bridge')
        ? 'bridge'
        : members.some((shape) => shape.connectivityRole === 'accent')
          ? 'accent'
          : 'normal';
    const area = loops.reduce((total, loop) => {
        let loopArea = 0;
        for (let index = 0; index < loop.length; index += 1) {
            const current = loop[index];
            const next = loop[(index + 1) % loop.length];
            loopArea += current.x * next.y - next.x * current.y;
        }
        return total + Math.abs(loopArea) * 0.5;
    }, 0);
    return {
        ...nearest,
        stableId: `merged:${members.map((shape) => shape.stableId).sort().join('|')}`,
        color: representative,
        sourceColors,
        accentScore,
        connectivityRole,
        area,
        centroid: { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 },
        loops,
        rasterBounds: {
            width: Math.max(1, Math.ceil(maxX) - Math.floor(minX)),
            height: Math.max(1, Math.ceil(maxY) - Math.floor(minY)),
            offsetX: Math.floor(minX),
            offsetY: Math.floor(minY),
        },
        depthSource: 'constant' as const,
        depthRange: [
            Math.min(...members.map((shape) => shape.depthRange[0])),
            Math.max(...members.map((shape) => shape.depthRange[1])),
        ] as [number, number],
        normal: nearest.normal,
    } satisfies ProjectedPartShape;
};

const unionVectorLoops = (members: ProjectedPartShape[]) => {
    if (members.length === 0) {
        return [] as Array<Array<{ x: number; y: number }>>;
    }
    try {
        const result = members.slice(1).reduce<MultiPolygon>(
            (current, shape) => polygonClipping.union(current, shapeToPolygon(shape)) as MultiPolygon,
            shapeToPolygon(members[0]),
        );
        return polygonToLoops(result);
    } catch {
        return members.flatMap((shape) => shape.loops);
    }
};

const getGroupShape = (
    group: GroupState,
    shapes: ProjectedPartShape[],
    cellSize: number,
    compositionMode: ProjectionOverlaySettings['compositionMode'],
    gridWidth: number,
    viewportWidth: number,
    viewportHeight: number,
) => {
    const members = group.members.map((index) => shapes[index]);
    if (members.length === 1) {
        return {
            ...members[0],
            stableId: members[0].stableId,
        };
    }

    if (compositionMode === 'vector') {
        const loops = getUnionLoops(members);
        return createMergedShape(members, loops) ?? makeFallbackMergedShape(members);
    }

    let minCellX = gridWidth;
    let minCellY = Math.ceil(viewportHeight / cellSize);
    let maxCellX = 0;
    let maxCellY = 0;
    group.cells.forEach((cell) => {
        const cellX = cell % gridWidth;
        const cellY = Math.floor(cell / gridWidth);
        minCellX = Math.min(minCellX, cellX);
        minCellY = Math.min(minCellY, cellY);
        maxCellX = Math.max(maxCellX, cellX);
        maxCellY = Math.max(maxCellY, cellY);
    });

    const offsetX = minCellX * cellSize;
    const offsetY = minCellY * cellSize;
    const width = Math.min(viewportWidth - offsetX, (maxCellX - minCellX + 1) * cellSize);
    const height = Math.min(viewportHeight - offsetY, (maxCellY - minCellY + 1) * cellSize);
    const mask = new Uint8Array(Math.max(1, width * height));
    group.cells.forEach((cell) => {
        const cellX = cell % gridWidth;
        const cellY = Math.floor(cell / gridWidth);
        const localStartX = Math.max(0, cellX * cellSize - offsetX);
        const localStartY = Math.max(0, cellY * cellSize - offsetY);
        const localEndX = Math.min(width, localStartX + cellSize);
        const localEndY = Math.min(height, localStartY + cellSize);
        for (let y = localStartY; y < localEndY; y += 1) {
            for (let x = localStartX; x < localEndX; x += 1) {
                mask[y * width + x] = 1;
            }
        }
    });

    const loops = extractLoopsFromMask(mask, width, height, offsetX, offsetY);
    const sourceColors = [...new Set(members.flatMap((shape) => shape.sourceColors))];
    const representative = medoidHexColor(sourceColors.length > 0 ? sourceColors : members.map((shape) => shape.color));
    const nearest = members.reduce((best, shape) => (shape.depth < best.depth ? shape : best), members[0]);
    const accentScore = Math.max(...members.map((shape) => shape.accentScore ?? 0));
    const connectivityRole = members.some((shape) => shape.connectivityRole === 'bridge')
        ? 'bridge'
        : members.some((shape) => shape.connectivityRole === 'accent')
          ? 'accent'
          : 'normal';
    const area = loops.reduce((total, loop) => {
        let loopArea = 0;
        for (let index = 0; index < loop.length; index += 1) {
            const current = loop[index];
            const next = loop[(index + 1) % loop.length];
            loopArea += current.x * next.y - next.x * current.y;
        }
        return total + Math.abs(loopArea) * 0.5;
    }, 0);
    const points = loops.flat();
    const centroid = points.length > 0
        ? points.reduce(
              (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
              { x: 0, y: 0 },
          )
        : { x: offsetX + width * 0.5, y: offsetY + height * 0.5 };
    const stableId = members.map((shape) => shape.stableId).sort().join('|');

    return {
        ...nearest,
        stableId: `merged:${stableId}`,
        color: representative,
        sourceColors,
        accentScore,
        connectivityRole,
        area,
        centroid,
        loops,
        rasterBounds: {
            width,
            height,
            offsetX,
            offsetY,
        },
        depthSource: 'constant' as const,
        depthRange: [
            Math.min(...members.map((shape) => shape.depthRange[0])),
            Math.max(...members.map((shape) => shape.depthRange[1])),
        ] as [number, number],
        normal: nearest.normal,
    };
};

export const composeProjectedShapes = (
    shapes: ProjectedPartShape[],
    sharedChains: ProjectionSharedChain[],
    settings: ProjectionOverlaySettings,
    viewportWidth: number,
    viewportHeight: number,
) => {
    if (shapes.length < 2 || viewportWidth <= 0 || viewportHeight <= 0) {
        return shapes;
    }

    if (settings.compositionMode === 'vector') {
        const unionFind = createUnionFind(shapes.length);
        const tolerance = settings.boundaryGuard === 'outerDepthNormalGap'
            ? settings.gapMergeThreshold
            : 0.25;
        for (let leftIndex = 0; leftIndex < shapes.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < shapes.length; rightIndex += 1) {
                if (
                    boundsCanTouch(shapes[leftIndex], shapes[rightIndex], tolerance) &&
                    canMergeShapes(shapes[leftIndex], shapes[rightIndex], settings, sharedChains)
                ) {
                    unionFind.union(leftIndex, rightIndex);
                }
            }
        }

        const vectorGroups = new Map<number, GroupState>();
        shapes.forEach((shape, shapeIndex) => {
            const root = unionFind.find(shapeIndex);
            const group = vectorGroups.get(root) ?? {
                root,
                members: [],
                cells: [],
                focusLevel: shape.focusLevel,
                macroGroup: shape.macroGroup,
                paintLayer: shape.paintLayer,
                area: 0,
                accentScore: shape.accentScore ?? 0,
                connectivityRole: shape.connectivityRole ?? 'normal',
            };
            group.members.push(shapeIndex);
            group.focusLevel = focusRank[shape.focusLevel] > focusRank[group.focusLevel]
                ? shape.focusLevel
                : group.focusLevel;
            group.area += shape.area;
            group.accentScore = Math.max(group.accentScore, shape.accentScore ?? 0);
            if (shape.connectivityRole === 'bridge') {
                group.connectivityRole = 'bridge';
            } else if (shape.connectivityRole === 'accent' && group.connectivityRole !== 'bridge') {
                group.connectivityRole = 'accent';
            }
            vectorGroups.set(root, group);
        });

        const retainedByFocus = new Map<Exclude<FocusLevel, 'auto'>, number>();
        const retained = [...vectorGroups.values()]
            .sort((left, right) => (right.accentScore - left.accentScore) * 1000 + right.area - left.area)
            .filter((group) => {
                const used = retainedByFocus.get(group.focusLevel) ?? 0;
                const budget = settings.focusShapeBudgets[group.focusLevel];
                const totalUsed = [...retainedByFocus.values()].reduce((sum, value) => sum + value, 0);
                const protectedShape = group.connectivityRole === 'bridge' || group.accentScore >= 0.65;
                if ((!protectedShape && used >= budget) || (!protectedShape && totalUsed >= settings.globalShapeBudget)) {
                    return false;
                }
                retainedByFocus.set(group.focusLevel, used + 1);
                return true;
            });

        return retained
            .map((group) => getGroupShape(group, shapes, 2, 'vector', 1, viewportWidth, viewportHeight))
            .filter((shape): shape is ProjectedPartShape => shape !== null);
    }

    const cellSize = getStyleModeDefaults(settings.styleMode).mergeGridScale;
    const gridWidth = Math.max(1, Math.ceil(viewportWidth / cellSize));
    const gridHeight = Math.max(1, Math.ceil(viewportHeight / cellSize));
    const labels = new Int32Array(gridWidth * gridHeight);
    labels.fill(-1);

    shapes.forEach((shape, shapeIndex) => {
        const xs = shape.loops.flatMap((loop) => loop.map((point) => point.x));
        const ys = shape.loops.flatMap((loop) => loop.map((point) => point.y));
        if (xs.length === 0 || ys.length === 0) {
            return;
        }
        const minX = Math.max(0, Math.floor(Math.min(...xs) / cellSize));
        const maxX = Math.min(gridWidth - 1, Math.ceil(Math.max(...xs) / cellSize));
        const minY = Math.max(0, Math.floor(Math.min(...ys) / cellSize));
        const maxY = Math.min(gridHeight - 1, Math.ceil(Math.max(...ys) / cellSize));
        for (let cellY = minY; cellY <= maxY; cellY += 1) {
            for (let cellX = minX; cellX <= maxX; cellX += 1) {
                const centerX = cellX * cellSize + cellSize * 0.5;
                const centerY = cellY * cellSize + cellSize * 0.5;
                if (!isPointInsideShape(shape, centerX, centerY)) {
                    continue;
                }
                const cellIndex = cellY * gridWidth + cellX;
                const existing = labels[cellIndex];
                if (existing < 0 || shape.depth < shapes[existing].depth) {
                    labels[cellIndex] = shapeIndex;
                }
            }
        }
    });

    const unionFind = createUnionFind(shapes.length);
    const neighbors = [
        [1, 0],
        [0, 1],
    ] as const;
    for (let cellY = 0; cellY < gridHeight; cellY += 1) {
        for (let cellX = 0; cellX < gridWidth; cellX += 1) {
            const current = labels[cellY * gridWidth + cellX];
            if (current < 0) {
                continue;
            }
            neighbors.forEach(([dx, dy]) => {
                const neighborX = cellX + dx;
                const neighborY = cellY + dy;
                if (neighborX >= gridWidth || neighborY >= gridHeight) {
                    return;
                }
                const neighbor = labels[neighborY * gridWidth + neighborX];
                if (neighbor >= 0 && canMergeShapes(shapes[current], shapes[neighbor], settings, sharedChains)) {
                    unionFind.union(current, neighbor);
                }
            });
        }
    }

    const groups = new Map<number, GroupState>();
    for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
        const root = unionFind.find(shapeIndex);
        const shape = shapes[shapeIndex];
        const group = groups.get(root) ?? {
            root,
            members: [],
            cells: [],
            focusLevel: shape.focusLevel,
            macroGroup: shape.macroGroup,
            paintLayer: shape.paintLayer,
            area: 0,
            accentScore: shape.accentScore ?? 0,
            connectivityRole: shape.connectivityRole ?? 'normal',
        };
        group.members.push(shapeIndex);
        group.focusLevel = focusRank[shape.focusLevel] > focusRank[group.focusLevel] ? shape.focusLevel : group.focusLevel;
        group.area += shape.area;
        group.accentScore = Math.max(group.accentScore, shape.accentScore ?? 0);
        if (shape.connectivityRole === 'bridge') {
            group.connectivityRole = 'bridge';
        } else if (shape.connectivityRole === 'accent' && group.connectivityRole !== 'bridge') {
            group.connectivityRole = 'accent';
        }
        groups.set(root, group);
    }

    labels.forEach((label, cellIndex) => {
        if (label < 0) {
            return;
        }
        const group = groups.get(unionFind.find(label));
        group?.cells.push(cellIndex);
    });

    const grouped = [...groups.values()];
    const retainedByFocus = new Map<Exclude<FocusLevel, 'auto'>, number>();
    const ordered = grouped.sort((left, right) => (right.accentScore - left.accentScore) * 1000 + right.area - left.area);
    const retained: GroupState[] = [];
    ordered.forEach((group) => {
        const budget = settings.focusShapeBudgets[group.focusLevel];
        const used = retainedByFocus.get(group.focusLevel) ?? 0;
        const protectedShape = group.connectivityRole === 'bridge' || group.accentScore >= 0.65;
        if (!protectedShape && (retained.length >= settings.globalShapeBudget || used >= budget)) {
            return;
        }
        retainedByFocus.set(group.focusLevel, used + 1);
        retained.push(group);
    });

    return retained
        .map((group) => getGroupShape(
            group,
            shapes,
            cellSize,
            settings.compositionMode,
            gridWidth,
            viewportWidth,
            viewportHeight,
        ))
        .filter((shape): shape is ProjectedPartShape => shape !== null)
        .filter((shape) => shape.loops.length > 0);
};
