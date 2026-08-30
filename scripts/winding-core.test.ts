// Regression: the writer must emit uniformly CCW triangles in the Core's
// exposed coordinate space. VTube Studio culls the other orientation, and
// mixed winding rendered as cull holes / vanishing meshes.
// Run: npx vitest run scripts/winding-core.test.ts
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { buildMoc3 } from '../src/lib/live2d/moc3';
import type { Live2dDrawable, Live2dModel } from '../src/lib/live2d/model';
import type { FaceParamId } from '../src/lib/live2d/types';

const paramIds: FaceParamId[] = ['ParamAngleX', 'ParamAngleY', 'ParamEyeLOpen', 'ParamMouthOpenY'];

const buildModel = (triangles: Uint32Array): Live2dModel => ({
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    modelName: 'winding-fixture',
    viewport: { width: 100, height: 200 },
    params: paramIds.map((id) => ({
        id,
        label: id,
        min: id.startsWith('ParamAngle') ? -30 : 0,
        max: id.startsWith('ParamAngle') ? 30 : 1,
        default: id === 'ParamEyeLOpen' ? 1 : 0,
    })),
    drawables: [
        {
            label: 'quad',
            id: 'quad',
            meshId: 'mesh',
            leafIds: [],
            vertexCount: 4,
            triangleCount: 2,
            triangles,
            meshVertexIndices: new Uint32Array([0, 1, 2, 3]),
            neutralPositions: new Float32Array([40, 60, 60, 60, 40, 80, 60, 80]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
            texture: { width: 2, height: 2, rgba: new Uint8Array(16) },
            renderOrder: 0,
        },
    ],
    families: {},
    depthFamilies: {},
    neutralDepths: [0],
    order: ['quad'],
    errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
    orderReport: { flips: [], samplesChecked: 0 },
});

const loadCore = async () => {
    const sandbox = {
        console, setTimeout, clearTimeout,
        atob: (t: string) => Buffer.from(t, 'base64').toString('binary'),
        btoa: (t: string) => Buffer.from(t, 'binary').toString('base64'),
        TextDecoder, TextEncoder,
    };
    (sandbox as Record<string, unknown>).self = sandbox;
    (sandbox as Record<string, unknown>).window = sandbox;
    (sandbox as Record<string, unknown>).document = { currentScript: null };
    (sandbox as Record<string, unknown>).location = { href: 'file:///' };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync('public/preview/live2dcubismcore.min.js', 'utf8'), sandbox);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return (sandbox as { Live2DCubismCore: unknown }).Live2DCubismCore as {
        Moc: { fromArrayBuffer: (b: ArrayBuffer) => unknown };
        Model: { fromMoc: (m: unknown) => {
            update: () => void;
            drawables: { vertexPositions: Float32Array[]; indices: Uint16Array[] };
        } };
    };
};

it('emits uniformly CCW winding in Core space for both input orientations', async () => {
    const core = await loadCore();
    for (const triangles of [new Uint32Array([0, 1, 2, 0, 2, 3]), new Uint32Array([0, 2, 1, 0, 3, 2])]) {
        const { moc3 } = buildMoc3(buildModel(triangles));
        const ab = moc3.buffer.slice(moc3.byteOffset, moc3.byteOffset + moc3.byteLength);
        const moc = core.Moc.fromArrayBuffer(ab);
        expect(moc).toBeTruthy();
        const model = core.Model.fromMoc(moc);
        expect(model).toBeTruthy();
        model.update();
        const positions = Array.from(model.drawables.vertexPositions[0]);
        const indices = Array.from(model.drawables.indices[0]);
        for (let t = 0; t + 2 < indices.length; t += 3) {
            const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
            const cross =
                (positions[b * 2] - positions[a * 2]) * (positions[c * 2 + 1] - positions[a * 2 + 1]) -
                (positions[b * 2 + 1] - positions[a * 2 + 1]) * (positions[c * 2] - positions[a * 2]);
            expect(cross).toBeGreaterThanOrEqual(0);
        }
    }
});
