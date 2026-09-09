import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { buildMoc3 } from './moc3';
import { createPoseEvaluator } from './keyforms';
import { defaultAssignment } from './paramMapping';
import type { Live2dModel } from './model';

it.each(['head', 'mouth'] as const)('exports joint-only movement and matches real Cubism Core throughout the %s grid', async (kind) => {
    const model: Live2dModel = {
        schemaVersion: 1, createdAt: '', modelName: 'joint-core-fixture', viewport: { width: 100, height: 100 },
        params: (['ParamAngleX', 'ParamAngleY'] as const).map((id) => ({ id, label: id, min: -30, max: 30, default: 0 })),
        drawables: [{
            id: 'face', label: 'face', meshId: 'mesh', leafIds: [], vertexCount: 4, triangleCount: 2,
            triangles: Uint32Array.from([0,1,2, 0,2,3]), meshVertexIndices: Uint32Array.from([0,1,2,3]),
            neutralPositions: Float32Array.from([30,30, 70,30, 70,70, 30,70]),
            uvs: Float32Array.from([0,0, 1,0, 1,1, 0,1]),
            texture: { width: 2, height: 2, rgba: new Uint8Array(16).fill(255) }, renderOrder: 0,
        }],
        families: {}, depthFamilies: {}, neutralDepths: [0], order: ['face'],
        errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
        orderReport: { flips: [], samplesChecked: 0 },
        jointKeyforms: [{
            x: { family: 'ParamAngleX', default: 0, values: [-30,0,30] },
            y: { family: 'ParamAngleY', default: 0, values: [-30,0,30] },
            displacements: Array.from({ length: 9 }, (_, i) => {
                const dx = [2,0,4,0,0,0,6,0,8][i];
                const dy = [-3,0,5,0,0,0,7,0,-9][i];
                return Float32Array.from([dx,dy,dx,dy,dx,dy,dx,dy]);
            }),
        }],
    };
    if (kind === 'mouth') {
        model.params = (['ParamMouthForm', 'ParamMouthOpenY'] as const).map(id => ({id,label:id,min:0,max:1,default:0}));
        model.jointKeyforms = [{
            x: { family:'ParamMouthForm',default:0,values:[0,1] },
            y: { family:'ParamMouthOpenY',default:0,values:[0,0.5,1] },
            displacements: Array.from({length:6},(_,i)=>Float32Array.from({length:8},(_,j)=>i%2 ? (j%2 ? -1 : 1)*(i+1) : 0)),
        }];
    }
    const sandbox = {
        console, setTimeout, clearTimeout, TextDecoder, TextEncoder,
        atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    };
    Object.assign(sandbox, { self: sandbox, window: sandbox, document: { currentScript: null }, location: { href: 'file:///' } });
    vm.createContext(sandbox);
    vm.runInContext(readFileSync('public/preview/live2dcubismcore.min.js', 'utf8'), sandbox);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const core = (sandbox as unknown as { Live2DCubismCore: {
        Moc: { fromArrayBuffer: (bytes: ArrayBuffer) => { _release: () => void } };
        Model: { fromMoc: (moc: unknown) => {
            update: () => void; release: () => void;
            parameters: { ids: string[]; values: Float32Array };
            drawables: { vertexPositions: Float32Array[] };
        } };
    } }).Live2DCubismCore;
    const result = buildMoc3(model);
    expect(result.keyformCounts[0]).toBeGreaterThanOrEqual(kind === 'head' ? 9 : 6);
    const moc = core.Moc.fromArrayBuffer(result.moc3.slice().buffer);
    expect(moc).toBeTruthy();
    const runtime = core.Model.fromMoc(moc);
    const outputs = [new Float32Array(8)];
    const evaluator = createPoseEvaluator(model.drawables, model.drawables.map((d) => d.neutralPositions), {}, model.jointKeyforms);
    try {
        // Corners, axes and half-steps detect both binding omissions and
        // X/Y tensor transposition that endpoint-only structural tests miss.
        const samples = kind === 'head' ? [-30,-15,0,15,30] : [0,0.25,0.5,0.75,1];
        for (const x of samples) for (const y of samples) {
            const assignment = { ...defaultAssignment(), [model.params[0].id]: x, [model.params[1].id]: y };
            runtime.parameters.ids.forEach((id, index) => {
                runtime.parameters.values[index] = id === model.params[0].id ? x : y;
            });
            runtime.update();
            evaluator.evaluate(assignment, outputs);
            for (let i = 0; i < 8; i++) {
                const value = runtime.drawables.vertexPositions[0][i];
                const pixel = (i % 2 ? -value : value) * 100 + 50;
                expect(pixel, `pose ${x}/${y}, coordinate ${i}`).toBeCloseTo(outputs[0][i], 3);
            }
        }
    } finally { runtime.release(); moc._release(); }
}, 10000);
