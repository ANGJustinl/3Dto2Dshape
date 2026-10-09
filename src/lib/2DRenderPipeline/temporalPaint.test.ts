import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { classifyShade, FLICKER_PRESETS, TemporalPaintState, scaleProjectionPixelSettings } from './temporalPaint';
import { createDefaultProjectionSettings } from '../2DRenderShared/defaultSettings';
import type { MeshProjectionCache } from '../2DRenderShared/types';
import type { ProjectionPartSource } from '../modelParts';
import type { ResolvedPartStyle } from '../2DRenderShared/focusResolver';

const part: ProjectionPartSource = {
    leafId: 'cloth', label: 'cloth', materialNames: ['cloth'], parentPath: '', mesh: new THREE.Mesh(),
    triangleCount: 1, color: '#808080',
    triangles: [{ vertexIndices: [0, 1, 2], vertexPositionKeys: ['a', 'b', 'c'] }],
};
const style: ResolvedPartStyle = { focusLevel: 'support', macroGroup: 'torso', shapeBudget: 30, simplifyMultiplier: 1, accentScore: 0, connectivityRole: 'normal' };
const cacheFor = (shade: number, area = 100): MeshProjectionCache => ({
    width: 640, height: 480,
    screenX: new Float32Array([0, 10, 0]), screenY: new Float32Array([0, 0, area / 5]),
    depth: new Float32Array(3), worldX: new Float32Array([0, 0, -shade]),
    worldY: new Float32Array([0, 1, 0]), worldZ: new Float32Array([0, 0, Math.sqrt(1 - shade ** 2)]),
} as MeshProjectionCache);
const settingsFor = (preset: keyof typeof FLICKER_PRESETS) => ({ ...createDefaultProjectionSettings(), lightDirection: [0, 0, 1] as [number, number, number], flickerControl: FLICKER_PRESETS[preset] });

describe('temporal paint experiments', () => {
    it('matches the original classifier when the band is zero', () => {
        for (const shade of [-1, -.301, -.30, -.299, 0, .619, .62, .621, 1]) {
            const expected = shade <= -.30 ? 0 : shade >= .62 ? 2 : 1;
            for (const previous of [undefined, 0, 1, 2]) expect(classifyShade(shade, -.30, .62, previous, 0)).toBe(expected);
        }
    });
    it('holds both sides of a shadow threshold inside the narrow band', () => {
        expect(classifyShade(-.301, -.30, .62, 1, .02)).toBe(1);
        expect(classifyShade(-.299, -.30, .62, 0, .02)).toBe(0);
        expect(classifyShade(-.33, -.30, .62, 1, .02)).toBe(0);
        expect(classifyShade(-.27, -.30, .62, 0, .02)).toBe(1);
    });
    it('does not delay a large lighting change and handles highlight transitions', () => {
        expect(classifyShade(1, -.30, .62, 0, .02)).toBe(2);
        expect(classifyShade(-1, -.30, .62, 2, .02)).toBe(0);
        expect(classifyShade(.619, -.30, .62, 2, .02)).toBe(2);
        expect(classifyShade(.621, -.30, .62, 1, .02)).toBe(1);
    });
    it('counts threshold reversals while hysteresis removes them', () => {
        const sequence = [-.31, -.29, -.31, -.29, -.31];
        const baseline = new TemporalPaintState(), experiment = new TemporalPaintState();
        let baselineReversals = 0, experimentReversals = 0;
        sequence.forEach((shade, i) => {
            for (const [state, preset] of [[baseline, 'baseline'], [experiment, 'shade']] as const) {
                const settings = settingsFor(preset);
                state.beginFrame(settings, i / 60, 640, 480);
                state.classifyPart(part, cacheFor(shade), settings, style);
            }
            baselineReversals += baseline.getStats().immediateReversals;
            experimentReversals += experiment.getStats().immediateReversals;
        });
        expect(baselineReversals).toBe(3);
        expect(experimentReversals).toBe(0);
    });
    it('uses different appearance and disappearance areas, and fills suppressed triangles with base', () => {
        const state = new TemporalPaintState(), settings = settingsFor('regions');
        const draw = (area: number, time: number) => {
            state.beginFrame(settings, time, 640, 480);
            return state.classifyPart(part, cacheFor(-.5, area), settings, style)[0];
        };
        expect(draw(8, 0)).toBe('base');
        expect(draw(12, .02)).toBe('shadow');
        expect(draw(8, .04)).toBe('shadow');
        expect(draw(4, .06)).toBe('base');
    });
    it('protects eye and mouth details from component merging', () => {
        const state = new TemporalPaintState(), settings = settingsFor('regions');
        for (const label of ['eye', '目影', 'mouth', '嘴']) {
            const detail = { ...part, label };
            expect(state.classifyPart(detail, cacheFor(-.5, 1), settings, style)[0]).toBe('shadow');
        }
    });
    it('resets history on seeking, long gaps, and viewport changes', () => {
        for (const [time, width] of [[-.01, 640], [2, 640], [.02, 800]]) {
            const state = new TemporalPaintState(), settings = settingsFor('shade');
            state.beginFrame(settings, 0, 640, 480);
            state.classifyPart(part, cacheFor(-.31), settings, style);
            state.beginFrame(settings, time, width, 480);
            expect(state.classifyPart(part, cacheFor(-.29), settings, style)[0]).toBe('base');
        }
    });
    it('resets on threshold edits and large light jumps', () => {
        for (const changed of [ { shadowThreshold: -.4 }, { lightDirection: [0, 1, 0] as [number, number, number] } ]) {
            const state = new TemporalPaintState(), settings = settingsFor('shade');
            state.beginFrame(settings, 0, 640, 480); state.classifyPart(part, cacheFor(-.31), settings, style);
            const next = { ...settings, ...changed };
            state.beginFrame(next, .02, 640, 480);
            state.classifyPart(part, cacheFor(-.29), next, style);
            expect(state.getStats().layerChanges).toBe(0);
        }
    });
    it('keeps history across dropped frame numbers because it uses sample time', () => {
        const state = new TemporalPaintState(), settings = settingsFor('shade');
        state.beginFrame(settings, 0, 640, 480); state.classifyPart(part, cacheFor(-.31), settings, style);
        state.beginFrame(settings, .25, 640, 480);
        expect(state.classifyPart(part, cacheFor(-.29), settings, style)[0]).toBe('shadow');
    });
    it('scales area and pixel widths consistently for denser visibility sampling', () => {
        const original = { ...settingsFor('sampling'), fillBleed: 1 };
        const scaled = scaleProjectionPixelSettings(original, 2);
        expect(scaled.minShapeArea).toBe(original.minShapeArea * 4);
        expect(scaled.strokeWidth).toBe(original.strokeWidth * 2);
        expect(scaled.fillBleed).toBe(2);
        expect(original.fillBleed).toBe(1);
    });
    it('does not mutate mesh input, projected vertices, or settings', () => {
        const state = new TemporalPaintState(), settings = settingsFor('combined'), cache = cacheFor(-.4);
        const original = JSON.stringify({ settings, positions: Array.from(cache.worldX), triangles: part.triangles });
        state.classifyPart(part, cache, settings, style);
        expect(JSON.stringify({ settings, positions: Array.from(cache.worldX), triangles: part.triangles })).toBe(original);
    });
    it('smooths small normal differences across a shared edge while preserving a sharp crease', () => {
        const paired = { ...part, triangleCount: 2, triangles: [part.triangles[0], { vertexIndices: [1, 0, 3] as [number, number, number], vertexPositionKeys: ['b','a','d'] as [string, string, string] }] };
        const settings = settingsFor('normals');
        const makeCache = (second: number) => ({ ...cacheFor(-.301),
            worldX: new Float32Array([0, 0, .301, second]), worldY: new Float32Array([0, 1, 0, 0]),
            worldZ: new Float32Array([0, 0, Math.sqrt(1 - .301 ** 2), -Math.sqrt(1 - second ** 2)]),
            screenX: new Float32Array([0,10,0,10]), screenY: new Float32Array([0,0,20,-20]), depth: new Float32Array(4),
        } as MeshProjectionCache);
        expect(new TemporalPaintState().classifyPart(paired, makeCache(-.2), settings, style)[0]).toBe('base');
        expect(new TemporalPaintState().classifyPart(paired, makeCache(.8), settings, style)[0]).toBe('shadow');
    });
    it('protects important facial features inferred by the style resolver', () => {
        const settings = settingsFor('regions');
        expect(new TemporalPaintState().classifyPart(part, cacheFor(-.5, 1), settings, { ...style, macroGroup: 'face', accentScore: 1 })[0]).toBe('shadow');
    });
});
