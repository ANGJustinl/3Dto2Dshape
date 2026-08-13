import { describe, expect, it } from 'vitest';
import { ShapeTrackState } from './shapeTracking';
import type { ProjectedPartShape, ProjectionOverlaySettings } from '../2DRenderShared/types';

const settings: ProjectionOverlaySettings = {
    enabled: true,
    styleMode: 'animationStable',
    simplifyEpsilon: 2,
    strokeWidth: 1,
    showContours: false,
    opacity: 1,
    minTriangleCount: 1,
    backgroundColor: '#FFFDF8',
    outlineColor: '#51443D',
    outlineOpacity: 0.4,
    shadowStrength: 0.3,
    highlightStrength: 0.2,
    shadowThreshold: 0.1,
    highlightThreshold: 0.7,
    lightDirection: [0, 1, 0],
    minShapeArea: 4,
    edgeRoughness: 0,
    edgeSmoothing: 'soft',
    enableComposition: false,
    enableShapeTracking: false,
    enableEdgeDistortion: false,
    compositionMode: 'vector',
    boundaryGuard: 'outerDepthNormal',
    depthMergeThreshold: 0.035,
    normalMergeThreshold: 0.61,
    gapMergeThreshold: 1.5,
    temporalStability: 0.8,
    globalShapeBudget: 64,
    focusShapeBudgets: { focal: 24, support: 16, abstract: 8 },
    mergeColorThreshold: 0.12,
    partOverrides: {},
};

const makeShape = (stableId: string, x: number): ProjectedPartShape => ({
    leafId: stableId,
    sourceLeafId: 'part',
    paintLayer: 'base',
    stableId,
    focusLevel: 'support',
    macroGroup: 'torso',
    edgeProfile: { mode: 'soft', hardness: 0.5, openness: 0, seed: 1 },
    sourceColors: ['#808080'],
    color: '#808080',
    depth: 0,
    area: 100,
    centroid: { x, y: 20 },
    depthRange: [0, 0],
    normal: [0, 0, 1],
    loops: [[{ x: x - 5, y: 15 }, { x: x + 5, y: 15 }, { x: x + 5, y: 25 }, { x: x - 5, y: 25 }]],
    rasterBounds: { width: 10, height: 10, offsetX: x - 5, offsetY: 15 },
    atlasRegion: { atlasX: 0, atlasY: 0, atlasWidth: 10, atlasHeight: 10 },
    orientedBounds: {
        center: { x, y: 20 },
        axisX: { x: 1, y: 0 },
        axisY: { x: 0, y: 1 },
        extentX: 5,
        extentY: 5,
    },
});

describe('shape tracking', () => {
    it('keeps the stable id and smooths small motion', () => {
        const tracker = new ShapeTrackState();
        tracker.stabilize([makeShape('source::base::1:1', 20)], settings, 1, 100, 100);
        const result = tracker.stabilize([makeShape('source::base::2:1', 22)], settings, 2, 100, 100);

        expect(result[0].stableId).toBe('source::base::1:1');
        expect(result[0].centroid.x).toBeLessThan(22);
    });

    it('resets tracking when the viewport changes', () => {
        const tracker = new ShapeTrackState();
        tracker.stabilize([makeShape('old', 20)], settings, 1, 100, 100);
        const result = tracker.stabilize([makeShape('new', 22)], settings, 2, 200, 100);

        expect(result[0].stableId).toBe('new');
    });
});
