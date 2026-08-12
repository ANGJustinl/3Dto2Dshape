import { polygonArea } from './geometry';
import type { ProjectedPartShape } from './types';

const MIN_RENDERED_PART_SCREEN_AREA = 12;

export const filterSmallProjectedPartShapes = (
    shapes: ProjectedPartShape[],
    minShapeArea = MIN_RENDERED_PART_SCREEN_AREA,
    focusMultipliers: Partial<Record<ProjectedPartShape['focusLevel'], number>> = {},
) =>
    shapes
        .map((shape) => ({
            ...shape,
            loops: shape.loops.filter(
                (loop) =>
                    shape.connectivityRole === 'bridge' ||
                    shape.connectivityRole === 'accent' ||
                    (shape.accentScore ?? 0) >= 0.65 ||
                    Math.abs(polygonArea(loop)) >=
                        minShapeArea * (focusMultipliers[shape.focusLevel] ?? 1),
            ),
        }))
        .filter((shape) => shape.loops.length > 0);
