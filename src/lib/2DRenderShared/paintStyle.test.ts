import { describe, expect, it } from 'vitest';
import { filterSmallProjectedPartShapes } from './filters';
import {
    getPaintLayerForShade,
    shadeColorForLayer,
} from './paintStyle';
import type { ProjectedPartShape, ProjectionOverlaySettings } from './types';

const settings: ProjectionOverlaySettings = {
    enabled: true,
    styleMode: 'animationStable',
    simplifyEpsilon: 4,
    strokeWidth: 1.25,
    showContours: false,
    opacity: 1,
    minTriangleCount: 1,
    backgroundColor: '#FFFDF8',
    outlineColor: '#51443D',
    outlineOpacity: 0.72,
    shadowStrength: 0.38,
    highlightStrength: 0.24,
    shadowThreshold: 0.08,
    highlightThreshold: 0.62,
    lightDirection: [0.35, 0.8, 0.45],
    minShapeArea: 12,
    edgeRoughness: 0.35,
    edgeSmoothing: 'soft',
    compositionMode: 'vector',
    boundaryGuard: 'outerDepthNormal',
    depthMergeThreshold: 0.035,
    normalMergeThreshold: 0.61,
    gapMergeThreshold: 1.5,
    temporalStability: 0.78,
    globalShapeBudget: 64,
    focusShapeBudgets: { focal: 24, support: 16, abstract: 8 },
    mergeColorThreshold: 0.12,
    partOverrides: {},
};

const makeShape = (loop: Array<{ x: number; y: number }>): ProjectedPartShape => ({
    leafId: 'part::base',
    sourceLeafId: 'part',
    paintLayer: 'base',
    stableId: 'part::base::1:1',
    focusLevel: 'support',
    macroGroup: 'torso',
    edgeProfile: { mode: 'soft', hardness: 0.62, openness: 0, seed: 1 },
    sourceColors: ['#AABBCC'],
    accentScore: 0,
    connectivityRole: 'normal',
    color: '#AABBCC',
    depth: 0,
    area: 32,
    centroid: { x: 5, y: 5 },
    depthRange: [0, 0],
    normal: [0, 0, 1],
    loops: [loop],
    rasterBounds: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
    atlasRegion: { atlasX: 0, atlasY: 0, atlasWidth: 20, atlasHeight: 20 },
    orientedBounds: {
        center: { x: 5, y: 5 },
        axisX: { x: 1, y: 0 },
        axisY: { x: 0, y: 1 },
        extentX: 5,
        extentY: 5,
    },
});

describe('paint style helpers', () => {
    it('classifies normal-light response into three paint layers', () => {
        expect(getPaintLayerForShade(-0.4, settings)).toBe('shadow');
        expect(getPaintLayerForShade(0.3, settings)).toBe('base');
        expect(getPaintLayerForShade(0.8, settings)).toBe('highlight');
    });

    it('adjusts base color for shadow and highlight layers', () => {
        expect(shadeColorForLayer('#808080', 'base', settings)).toBe('#808080');
        expect(shadeColorForLayer('#808080', 'shadow', settings)).not.toBe('#808080');
        expect(shadeColorForLayer('#808080', 'highlight', settings)).not.toBe('#808080');
    });
});

describe('projected shape filtering', () => {
    it('keeps loops above the configured screen-area threshold', () => {
        const small = makeShape([
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 0, y: 2 },
        ]);
        const large = makeShape([
            { x: 0, y: 0 },
            { x: 8, y: 0 },
            { x: 0, y: 8 },
        ]);

        const result = filterSmallProjectedPartShapes([small, large], 12);
        expect(result).toHaveLength(1);
        expect(result[0].loops).toHaveLength(1);
    });

    it('keeps a tiny connectivity bridge and high-value accent', () => {
        const bridge = {
            ...makeShape([
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 0, y: 1 },
            ]),
            connectivityRole: 'bridge' as const,
        };
        const eye = {
            ...makeShape([
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 0, y: 1 },
            ]),
            accentScore: 1,
        };
        expect(filterSmallProjectedPartShapes([bridge, eye], 12)).toHaveLength(2);
    });
});
