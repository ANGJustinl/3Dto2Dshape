import { polygonArea } from './geometry';
import type { ProjectedPartShape } from './types';

const MIN_RENDERED_PART_SCREEN_AREA = 48;

export const filterSmallProjectedPartShapes = (shapes: ProjectedPartShape[]) =>
    shapes
        .map((shape) => ({
            ...shape,
            loops: shape.loops.filter((loop) => Math.abs(polygonArea(loop)) >= MIN_RENDERED_PART_SCREEN_AREA),
        }))
        .filter((shape) => shape.loops.length > 0);
