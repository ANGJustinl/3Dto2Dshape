import { describe, expect, it } from 'vitest';
import { composeProjectedShapes } from './shapeComposition';
import type { ProjectedPartShape, ProjectionOverlaySettings } from '../../2DRenderShared/types';

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
    enableComposition: true,
    enableShapeTracking: false,
    enableEdgeDistortion: false,
    compositionMode: 'vector',
    boundaryGuard: 'outerDepthNormal',
    depthMergeThreshold: 0.035,
    normalMergeThreshold: 0.61,
    gapMergeThreshold: 1.5,
    temporalStability: 0.7,
    globalShapeBudget: 64,
    focusShapeBudgets: { focal: 24, support: 16, abstract: 8 },
    mergeColorThreshold: 0.12,
    partOverrides: {},
};

const rectangle = (left: number, top: number, right: number, bottom: number) => [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
];

const makeShape = (
    id: string,
    loop: Array<{ x: number; y: number }>,
    color: string,
    focusLevel: ProjectedPartShape['focusLevel'] = 'support',
    depth = 0,
    normal: [number, number, number] = [0, 0, 1],
    sourceLeafId = id,
): ProjectedPartShape => ({
    leafId: id,
    sourceLeafId,
    paintLayer: 'base',
    stableId: id,
    focusLevel,
    macroGroup: focusLevel === 'focal' ? 'face' : 'torso',
    edgeProfile: { mode: 'soft', hardness: 0.5, openness: 0, seed: 1 },
    sourceColors: [color],
    color,
    depth,
    area: Math.abs((loop[1].x - loop[0].x) * (loop[2].y - loop[1].y)),
    centroid: { x: (loop[0].x + loop[2].x) / 2, y: (loop[0].y + loop[2].y) / 2 },
    depthRange: [depth, depth],
    normal,
    loops: [loop],
    rasterBounds: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
    atlasRegion: { atlasX: 0, atlasY: 0, atlasWidth: 20, atlasHeight: 20 },
    orientedBounds: {
        center: { x: 10, y: 10 },
        axisX: { x: 1, y: 0 },
        axisY: { x: 0, y: 1 },
        extentX: 10,
        extentY: 10,
    },
});

describe('screen-space shape composition', () => {
    it('merges adjacent same-color shapes into one large shape', () => {
        const result = composeProjectedShapes(
            [
                makeShape('left', rectangle(4, 4, 12, 16), '#808080', 'support', 0, [0, 0, 1], 'shared'),
                makeShape('right', rectangle(12, 4, 20, 16), '#808080', 'support', 0, [0, 0, 1], 'shared'),
            ],
            [],
            settings,
            32,
            24,
        );

        expect(result).toHaveLength(1);
        expect(result[0].stableId).toContain('merged:');
    });

    it('keeps cross-source shapes separate under the default depth guard', () => {
        const result = composeProjectedShapes(
            [
                makeShape('left', rectangle(4, 4, 12, 16), '#808080'),
                makeShape('right', rectangle(12, 4, 20, 16), '#808080'),
            ],
            [],
            settings,
            32,
            24,
        );

        expect(result).toHaveLength(2);
    });

    it('keeps distant colors and focal boundaries separate', () => {
        const result = composeProjectedShapes(
            [
                makeShape('left', rectangle(4, 4, 12, 16), '#202020'),
                makeShape('right', rectangle(12, 4, 20, 16), '#D0D0D0', 'focal'),
            ],
            [],
            settings,
            32,
            24,
        );

        expect(result.length).toBe(2);
    });

    it('keeps foreground and rear shapes separate when depth or normal changes', () => {
        const result = composeProjectedShapes(
            [
                makeShape('face', rectangle(4, 4, 12, 16), '#808080', 'support', 0.1),
                makeShape('hair', rectangle(12, 4, 20, 16), '#808080', 'support', 0.2, [0, 1, 0]),
            ],
            [],
            settings,
            32,
            24,
        );

        expect(result).toHaveLength(2);
    });

    it('never unions focal visibility anchors even when color and depth match', () => {
        const result = composeProjectedShapes(
            [
                makeShape('face-a', rectangle(4, 4, 12, 16), '#808080', 'focal'),
                makeShape('face-b', rectangle(12, 4, 20, 16), '#808080', 'focal'),
            ],
            [],
            settings,
            32,
            24,
        );

        expect(result).toHaveLength(2);
        expect(result.every((shape) => shape.depthSource !== 'constant')).toBe(true);
    });

    it('respects the global shape budget by retaining the largest candidates', () => {
        const result = composeProjectedShapes(
            [
                makeShape('large', rectangle(0, 0, 24, 20), '#808080'),
                makeShape('small-a', rectangle(25, 0, 28, 3), '#404040'),
                makeShape('small-b', rectangle(25, 5, 28, 8), '#404040'),
            ],
            [],
            { ...settings, globalShapeBudget: 1, focusShapeBudgets: { focal: 1, support: 1, abstract: 1 } },
            32,
            24,
        );

        expect(result).toHaveLength(1);
        expect(result[0].stableId).toBe('large');
    });
});
