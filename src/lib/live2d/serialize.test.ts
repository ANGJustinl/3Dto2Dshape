import { describe, expect, it } from 'vitest';
import type { Live2dModel } from './model';
import { exportModel, importModel, verifyRoundtripBytes, type PngCodec } from './serialize';
import { createZip, parseZip } from './zip';

/**
 * The PNG codec is stubbed at byte level: encode wraps raw RGBA in a length
 * header, decode unwraps it. That keeps the format round-trip testable in
 * node while the browser path uses real canvas PNG.
 */
const stubCodec: PngCodec = {
    encode: (texture) => {
        const header = new Uint8Array(8);
        new DataView(header.buffer).setUint32(0, texture.width, true);
        new DataView(header.buffer).setUint32(4, texture.height, true);
        const out = new Uint8Array(8 + texture.rgba.length);
        out.set(header, 0);
        out.set(texture.rgba, 8);
        return out;
    },
    decode: async (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
            width: view.getUint32(0, true),
            height: view.getUint32(4, true),
            rgba: bytes.slice(8),
        };
    },
};

const buildModel = (): Live2dModel => {
    const vertexCount = 4;
    const neutralPositions = Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
    const uvs = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
    const texture = {
        width: 2,
        height: 2,
        rgba: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    };
    const displacements = [
        Float32Array.from([-1, -1, -1, -2, -1, -3, -1, -4]),
        Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
        Float32Array.from([1, 1, 1, 2, 1, 3, 1, 4]),
    ];
    return {
        schemaVersion: 1,
        createdAt: '2026-08-26T00:00:00.000Z',
        modelName: 'roundtrip-test',
        viewport: { width: 1024, height: 1024 },
        params: [
            { id: 'ParamAngleX', label: 'Head yaw', min: -30, max: 30, default: 0 },
        ],
        drawables: [
            {
                id: 'face-0',
                label: 'face',
                meshId: 'mesh-1',
                leafIds: ['face-a'],
                vertexCount,
                triangleCount: 2,
                triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
                meshVertexIndices: Uint32Array.from([3, 7, 12, 40]),
                neutralPositions,
                uvs,
                texture,
                renderOrder: 1,
            },
        ],
        families: {
            ParamAngleX: { family: 'ParamAngleX', default: 0, values: [-10, 0, 10], displacements },
        },
        depthFamilies: {
            ParamAngleX: {
                family: 'ParamAngleX',
                default: 0,
                values: [-10, 0, 10],
                displacements: [Float32Array.from([0.1]), Float32Array.from([0]), Float32Array.from([-0.1])],
            },
        },
        neutralDepths: [0.2],
        order: ['face-0'],
        errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
        orderReport: { flips: [], samplesChecked: 0 },
    };
};

describe('store zip', () => {
    it('round-trips entries byte-identically', () => {
        const entries = [
            { name: 'a.json', data: new TextEncoder().encode('{"hello":"世界"}') },
            { name: 'bin/data.bin', data: Uint8Array.from([0, 1, 2, 255, 254]) },
        ];
        const zip = createZip(entries);
        const parsed = parseZip(zip);
        expect([...parsed.keys()].sort()).toEqual(['a.json', 'bin/data.bin']);
        expect(new TextDecoder().decode(parsed.get('a.json')!)).toBe('{"hello":"世界"}');
        expect([...parsed.get('bin/data.bin')!]).toEqual([0, 1, 2, 255, 254]);
    });

    it('rejects empty archives', () => {
        expect(() => parseZip(new Uint8Array(10))).toThrow('No zip entries');
    });
});

describe('live2d model serialization', () => {
    it('exports and re-imports into an identical model', async () => {
        const model = buildModel();
        const zipBytes = exportModel(model, stubCodec);
        const reimported = await importModel(zipBytes, stubCodec);

        expect(reimported.modelName).toBe('roundtrip-test');
        expect(reimported.drawables).toHaveLength(1);
        expect(reimported.drawables[0].renderOrder).toBe(0); // only drawable -> index 0
        expect(reimported.order).toEqual(['face-0']);
        expect(reimported.params).toEqual(model.params);

        const problems = verifyRoundtripBytes(model, reimported);
        // renderOrder differs (1 vs 0) by design in this fixture; the checker
        // only compares it when ids line up — assert the real buffers match.
        const bufferProblems = problems.filter((problem) => !problem.includes('render order'));
        expect(bufferProblems).toEqual([]);
    });

    it('verifyRoundtripBytes catches corruption', async () => {
        const model = buildModel();
        const zipBytes = exportModel(model, stubCodec);
        const reimported = await importModel(zipBytes, stubCodec);
        reimported.drawables[0].neutralPositions[0] = 999;
        reimported.families.ParamAngleX.displacements[0][0] = 999;
        const problems = verifyRoundtripBytes(model, reimported);
        expect(problems.some((problem) => problem.includes('neutral positions differ'))).toBe(true);
        expect(problems.some((problem) => problem.includes('keyform 0: bytes differ'))).toBe(true);
    });
});
