import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolvePartStyle } from './focusResolver';
import type { ProjectionOverlaySettings } from './types';
import type { ProjectionPartSource } from '../modelParts';

const settings: ProjectionOverlaySettings = {
    enabled: true,
    styleMode: 'animationStable',
    simplifyEpsilon: 4,
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
    minShapeArea: 12,
    edgeRoughness: 0.2,
    edgeSmoothing: 'soft',
    enableComposition: false,
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

const makePart = (label: string): ProjectionPartSource => ({
    leafId: label,
    label,
    materialNames: [label],
    parentPath: 'Corin',
    mesh: new THREE.Mesh(),
    triangleCount: 1,
    color: '#AABBCC',
    triangles: [{
        vertexIndices: [0, 1, 2],
        vertexPositionKeys: ['0', '1', '2'],
    }],
});

const cache = {
    width: 100,
    height: 100,
    screenX: new Float32Array([45, 55, 50]),
    screenY: new Float32Array([20, 20, 30]),
    depth: new Float32Array([0, 0, 0]),
    worldX: new Float32Array([0, 1, 0]),
    worldY: new Float32Array([0, 0, 1]),
    worldZ: new Float32Array([0, 0, 0]),
};

describe('focus resolver', () => {
    it('classifies face and lower mass regions with different abstraction levels', () => {
        const face = resolvePartStyle(makePart('face_skin'), cache, settings);
        const lower = resolvePartStyle(makePart('cloud_base'), {
            ...cache,
            screenY: new Float32Array([80, 80, 90]),
        }, settings);

        expect(face.focusLevel).toBe('focal');
        expect(face.macroGroup).toBe('face');
        expect(lower.focusLevel).toBe('abstract');
        expect(lower.macroGroup).toBe('lowerMass');
    });

    it('lets a leaf override the automatic focus assignment', () => {
        const overridden = resolvePartStyle(makePart('face_skin'), cache, {
            ...settings,
            partOverrides: { face_skin: { focusLevel: 'abstract', shapeBudget: 3 } },
        });

        expect(overridden.focusLevel).toBe('abstract');
        expect(overridden.shapeBudget).toBe(3);
    });
});
