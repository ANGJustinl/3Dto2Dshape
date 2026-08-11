import { polygonArea } from './geometry';
import type { ProjectedPartShape } from './types';

const MIN_RENDERED_PART_SCREEN_AREA = 12;

export const filterSmallProjectedPartShapes = (
    shapes: ProjectedPartShape[],
    minShapeArea = MIN_RENDERED_PART_SCREEN_AREA,
) =>
    shapes
        .map((shape) => ({
            ...shape,
            loops: shape.loops.filter((loop) => Math.abs(polygonArea(loop)) >= minShapeArea),
        }))
        .filter((shape) => shape.loops.length > 0);
