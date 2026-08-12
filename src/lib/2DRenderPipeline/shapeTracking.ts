import type { ProjectedPartShape, ProjectionOverlaySettings } from '../2DRenderShared/types';

const focusRank = { abstract: 0, support: 1, focal: 2 } as const;

const colorDistance = (left: string, right: string) => {
    const parse = (value: string) => {
        const normalized = value.replace('#', '');
        return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
    };
    const a = parse(left);
    const b = parse(right);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

const shapeDistance = (left: ProjectedPartShape, right: ProjectedPartShape) => {
    const dx = left.centroid.x - right.centroid.x;
    const dy = left.centroid.y - right.centroid.y;
    const areaRatio = Math.abs(left.area - right.area) / Math.max(1, left.area, right.area);
    return Math.hypot(dx, dy) + areaRatio * 40 + colorDistance(left.color, right.color) * 80;
};

export class ShapeTrackState {
    private previousShapes = new Map<string, ProjectedPartShape>();
    private previousFrameId = -1;
    private previousWidth = 0;
    private previousHeight = 0;
    private previousMode: ProjectionOverlaySettings['styleMode'] | null = null;

    reset() {
        this.previousShapes.clear();
        this.previousFrameId = -1;
        this.previousWidth = 0;
        this.previousHeight = 0;
        this.previousMode = null;
    }

    stabilize(
        shapes: ProjectedPartShape[],
        settings: ProjectionOverlaySettings,
        frameId: number,
        viewportWidth: number,
        viewportHeight: number,
    ) {
        if (settings.styleMode === 'stillPainterly' || settings.temporalStability <= 0) {
            this.previousShapes = new Map(shapes.map((shape) => [shape.stableId, shape]));
            this.previousFrameId = frameId;
            this.previousWidth = viewportWidth;
            this.previousHeight = viewportHeight;
            this.previousMode = settings.styleMode;
            return shapes;
        }

        if (
            this.previousMode !== settings.styleMode ||
            this.previousWidth !== viewportWidth ||
            this.previousHeight !== viewportHeight ||
            (this.previousFrameId >= 0 && (frameId < this.previousFrameId || frameId - this.previousFrameId > 4))
        ) {
            this.reset();
        }

        const usedPrevious = new Set<string>();
        const stability = Math.max(0, Math.min(1, settings.temporalStability));
        const stabilized = shapes.map((shape) => {
            let previous = this.previousShapes.get(shape.stableId);
            if (!previous) {
                previous = [...this.previousShapes.values()]
                    .filter(
                        (candidate) =>
                            candidate.paintLayer === shape.paintLayer &&
                            candidate.macroGroup === shape.macroGroup &&
                            focusRank[candidate.focusLevel] === focusRank[shape.focusLevel],
                    )
                    .sort((left, right) => shapeDistance(shape, left) - shapeDistance(shape, right))[0];
            }

            if (!previous || usedPrevious.has(previous.stableId) || shapeDistance(shape, previous) > 180) {
                return shape;
            }

            usedPrevious.add(previous.stableId);
            const dx = (previous.centroid.x - shape.centroid.x) * stability;
            const dy = (previous.centroid.y - shape.centroid.y) * stability;
            return {
                ...shape,
                stableId: previous.stableId,
                centroid: {
                    x: shape.centroid.x + dx,
                    y: shape.centroid.y + dy,
                },
                loops: shape.loops.map((loop) =>
                    loop.map((point) => ({ x: point.x + dx, y: point.y + dy })),
                ),
                color: colorDistance(previous.color, shape.color) < 0.12 ? previous.color : shape.color,
            };
        });

        this.previousShapes = new Map(stabilized.map((shape) => [shape.stableId, shape]));
        this.previousFrameId = frameId;
        this.previousWidth = viewportWidth;
        this.previousHeight = viewportHeight;
        this.previousMode = settings.styleMode;
        return stabilized;
    }
}
