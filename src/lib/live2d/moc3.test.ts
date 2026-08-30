import { describe, expect, it } from 'vitest';
import type { FamilyKeyforms } from './keyforms';
import { buildMoc3, buildMoc3Archive, packTextureAtlas } from './moc3';
import type { Live2dDrawable, Live2dModel } from './model';
import type { FaceParamId } from './types';
import { parseZip } from './zip';

/**
 * Structural self-checks against the layout reverse-engineered from the
 * VTube Studio sample models: flattened 101-slot pointer table at 0x40,
 * data from 0x7C0, counts/begins in floats for uv/keyform positions, and
 * the two distinct binding-slice pools (params slice parameterBindings
 * directly; keyformBindings slice the pbi pool).
 */

const PARAM_IDS: FaceParamId[] = [
    'ParamAngleX',
    'ParamAngleY',
    'ParamAngleZ',
    'ParamEyeLOpen',
    'ParamEyeROpen',
    'ParamMouthOpenY',
];

const paramDefinition = (id: FaceParamId) => ({
    id,
    label: id,
    min: id.startsWith('ParamAngle') ? -30 : 0,
    max: id.startsWith('ParamAngle') ? 30 : 1,
    default: id.startsWith('ParamEye') ? 1 : 0,
});

const drawable = (overrides: Partial<Live2dDrawable> & Pick<Live2dDrawable, 'id'>): Live2dDrawable => ({
    label: overrides.id,
    meshId: 'mesh',
    leafIds: [],
    vertexCount: 3,
    triangleCount: 1,
    triangles: new Uint32Array([0, 1, 2]),
    meshVertexIndices: new Uint32Array([0, 1, 2]),
    neutralPositions: new Float32Array([10, 20, 30, 20, 20, 40]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { width: 2, height: 2, rgba: new Uint8Array(16) },
    renderOrder: 0,
    ...overrides,
});

const buildFixtureModel = (): Live2dModel => ({
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    modelName: 'fixture',
    viewport: { width: 100, height: 200 },
    params: PARAM_IDS.map(paramDefinition),
    drawables: [
        drawable({ id: 'body', renderOrder: 0 }),
        drawable({
            id: 'head',
            vertexCount: 4,
            triangleCount: 2,
            triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
            meshVertexIndices: new Uint32Array([0, 1, 2, 3]),
            neutralPositions: new Float32Array([40, 60, 60, 60, 40, 80, 60, 80]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
            renderOrder: 1,
        }),
    ],
    // Head swings symmetrically with AngleX; body never moves (zero block).
    families: {
        ParamAngleX: {
            family: 'ParamAngleX',
            default: 0,
            values: [-30, 30],
            displacements: [
                new Float32Array([
                    0, 0, 0, 0, 0, 0, // body: 3 verts
                    -6, 0, -6, 0, -6, 0, -6, 0, // head at -30
                ]),
                new Float32Array([
                    0, 0, 0, 0, 0, 0,
                    6, 0, 6, 0, 6, 0, 6, 0, // head at +30
                ]),
            ],
        } satisfies FamilyKeyforms,
    },
    depthFamilies: {},
    neutralDepths: [0, 0],
    order: ['body', 'head'],
    errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
    orderReport: { flips: [], samplesChecked: 0 },
});

/** Slot indices matching the writer's SLOT map. */
const SLOT = {
    countInfo: 0,
    canvas: 1,
    partsIds: 3,
    partsKbsi: 4,
    partsKsbi: 5,
    partsKsc: 6,
    amIds: 33,
    amKbsi: 34,
    amKsbi: 35,
    amKsc: 36,
    amVertexCounts: 43,
    amUvBegins: 44,
    paramsIds: 50,
    paramsMax: 51,
    paramsPbsbi: 56,
    paramsPbsc: 57,
    partKfDrawOrders: 58,
    amKfDrawOrders: 69,
    amKfKpBegins: 70,
    kfPos: 71,
    pbi: 72,
    kbPbisbi: 73,
    kbPbisc: 74,
    pbKeysBegins: 75,
    pbKeysCounts: 76,
    keys: 77,
    uvs: 78,
    positionIndices: 79,
} as const;

const MID_EMPTY_SLOTS = [
    ...Array.from({ length: 19 }, (_, index) => 10 + index), // deformers/warp/rotation
    ...Array.from({ length: 9 }, (_, index) => 59 + index), // deformer keyforms
    80, // masks
];
const TRAILING_EMPTY_SLOTS = Array.from({ length: 12 }, (_, index) => 89 + index); // glue

const buildReader = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (offset: number) => view.getUint32(offset, true);
    const s32 = (offset: number) => view.getInt32(offset, true);
    const f32 = (offset: number) => view.getFloat32(offset, true);
    const s16 = (offset: number) => view.getInt16(offset, true);
    const slot = (index: number) => u32(0x40 + index * 4);
    const idAt = (offset: number) => {
        const decoder = new TextDecoder();
        let end = offset;
        while (end < offset + 64 && bytes[end] !== 0) {
            end += 1;
        }
        return decoder.decode(bytes.subarray(offset, end));
    };
    return { view, u32, s32, f32, s16, slot, idAt };
};

describe('moc3 writer structure', () => {
    const model = buildFixtureModel();
    const { moc3, keyformCounts } = buildMoc3(model);
    const read = buildReader(moc3);

    it('writes the header and flattened slot table', () => {
        expect(moc3.length).toBeGreaterThan(0x7c0);
        expect([...moc3.slice(0, 4)]).toEqual([0x4d, 0x4f, 0x43, 0x33]);
        expect(moc3[4]).toBe(1); // version 3.0.0 (VTS sample-model layout)
        expect(moc3[5]).toBe(0); // little endian
        for (let index = 0; index < 101; index += 1) {
            const pointer = read.u32(0x40 + index * 4);
            expect(pointer).toBeGreaterThanOrEqual(0x7c0);
            expect(pointer).toBeLessThanOrEqual(moc3.length);
        }
    });

    it('writes the count table with float-unit totals', () => {
        const counts = read.slot(SLOT.countInfo);
        const expected = [
            2, // parts
            0, 0, 0, // deformers
            2, // art meshes
            6, // parameters
            2, // part keyforms (one per part)
            0, 0, // deformer keyforms (warp, rotation)
            4, // art mesh keyforms: body 1 + head 3 (angle grid)
            64, // keyform positions: 4 rows x 16-float padded stride
            1, // parameter binding indices
            2, // keyform bindings: dummy + head
            1, // parameter bindings
            3, // keys: one AngleX binding with 3 keys
            14, // uvs: (3 + 4 verts) * 2 floats
            9, // position indices: 3 + 6
            0, // drawable masks
            1, // draw order groups
            2, // draw order group objects
            0, 0, 0, // glue
        ];
        expected.forEach((value, index) => {
            expect(read.u32(counts + index * 4)).toBe(value);
        });
        // The count table is a fixed 128-byte section; the canvas section
        // sits exactly 128 bytes later, as the consistency checker demands.
        expect(read.slot(SLOT.canvas)).toBe(counts + 128);
        expect(keyformCounts).toEqual([1, 3]);
    });

    it('writes the canvas with pixelsPerUnit = width', () => {
        const canvas = read.slot(SLOT.canvas);
        expect(read.f32(canvas)).toBe(100); // pixels per unit = width
        expect(read.f32(canvas + 12)).toBe(100);
        expect(read.f32(canvas + 16)).toBe(200);
    });

    it('writes parts and artmesh tables with the empty-binding convention', () => {
        expect(read.idAt(read.slot(SLOT.partsIds))).toBe('Pbody');
        expect(read.s32(read.slot(SLOT.partsKsbi))).toBe(0);
        expect(read.s32(read.slot(SLOT.partsKsc))).toBe(1);

        expect(read.idAt(read.slot(SLOT.amIds))).toBe('Dbody');
        expect(read.idAt(read.slot(SLOT.amIds) + 64)).toBe('Dhead');
        // body (static) -> empty binding 0; head -> binding 1.
        const kbsi = read.slot(SLOT.amKbsi);
        expect(read.s32(kbsi)).toBe(0);
        expect(read.s32(kbsi + 4)).toBe(1);
        const ksbi = read.slot(SLOT.amKsbi);
        expect(read.s32(ksbi)).toBe(0);
        expect(read.s32(ksbi + 4)).toBe(1);
        const ksc = read.slot(SLOT.amKsc);
        expect(read.s32(ksc)).toBe(1);
        expect(read.s32(ksc + 4)).toBe(3);
        // uv begins are in floats: head starts after body's 3 verts.
        const uvBegins = read.slot(SLOT.amUvBegins);
        expect(read.s32(uvBegins)).toBe(0);
        expect(read.s32(uvBegins + 4)).toBe(6);
    });

    it('binds only the moving artmesh to AngleX via the pbi pool', () => {
        const params = read.slot(SLOT.paramsIds);
        expect(read.idAt(params)).toBe('ParamAngleX');
        expect(read.idAt(params + 64 * 3)).toBe('ParamEyeLOpen');

        // AngleX drives exactly one parameterBinding directly (the head's);
        // every other param binds none.
        const pbsc = read.slot(SLOT.paramsPbsc);
        expect(read.s32(pbsc)).toBe(1);
        expect(read.s32(pbsc + 4 * 5)).toBe(0);

        // keyformBindings: kb[0] is the shared empty binding, kb[1] = head.
        const kbBegins = read.slot(SLOT.kbPbisbi);
        const kbCounts = read.slot(SLOT.kbPbisc);
        expect(read.s32(kbBegins)).toBe(0);
        expect(read.s32(kbCounts)).toBe(0);
        expect(read.s32(kbBegins + 4)).toBe(0);
        expect(read.s32(kbCounts + 4)).toBe(1);

        // The pbi pool maps the head's range to its parameterBinding.
        expect(read.s32(read.slot(SLOT.pbi))).toBe(0);

        // The head's binding covers the AngleX keys [-30, 0, 30].
        const keysBegins = read.slot(SLOT.pbKeysBegins);
        const keysCounts = read.slot(SLOT.pbKeysCounts);
        expect(read.s32(keysCounts)).toBe(3);
        const keys = read.slot(SLOT.keys);
        expect(read.s32(keysBegins)).toBe(0);
        expect(read.f32(keys)).toBeCloseTo(-30, 4);
        expect(read.f32(keys + 4)).toBeCloseTo(0, 4);
        expect(read.f32(keys + 8)).toBeCloseTo(30, 4);
    });

    it('evaluates neutral keyform positions exactly in canvas units', () => {
        // Head keyforms start at index 1; the neutral (value 0) grid slot is
        // the middle one because [-6, +6] displacements average to zero.
        // Positions are centered pixels divided by pixelsPerUnit (100).
        const kpBegins = read.slot(SLOT.amKfKpBegins);
        const headNeutralFloatBegin = read.s32(kpBegins + 2 * 4);
        const positions = read.slot(SLOT.kfPos);
        const expected = [
            (40 - 50) / 100, (60 - 100) / 100,
            (60 - 50) / 100, (60 - 100) / 100,
            (40 - 50) / 100, (80 - 100) / 100,
            (60 - 50) / 100, (80 - 100) / 100,
        ];
        expected.forEach((value, index) => {
            expect(read.f32(positions + headNeutralFloatBegin * 4 + index * 4)).toBeCloseTo(value, 4);
        });
        // The -30 keyform shifts left by 6px for every vertex.
        const headMinFloatBegin = read.s32(kpBegins + 1 * 4);
        expect(read.f32(positions + headMinFloatBegin * 4)).toBeCloseTo((34 - 50) / 100, 4);
    });

    it('flips UV v-coordinates and writes s16 indices', () => {
        const uvs = read.slot(SLOT.uvs);
        // Head occupies verts 3..6: stored v values 0,0,1,1 (unflipped —
        // VTS applies its own v inversion at sampling time).
        expect(read.f32(uvs + 3 * 8 + 4)).toBeCloseTo(0, 5);
        expect(read.f32(uvs + 4 * 8 + 4)).toBeCloseTo(0, 5);
        expect(read.f32(uvs + 5 * 8 + 4)).toBeCloseTo(1, 5);
        expect(read.f32(uvs + 6 * 8 + 4)).toBeCloseTo(1, 5);

        const indices = read.slot(SLOT.positionIndices);
        expect(read.s16(indices + 3 * 2)).toBe(0);
        // Winding normalization flips the CW-stored second triangle to
        // (0, 3, 2) so every triangle is CCW in the Core's exposed space.
        expect(read.s16(indices + 6 * 2)).toBe(0);
        expect(read.s16(indices + 7 * 2)).toBe(3);
        expect(read.s16(indices + 8 * 2)).toBe(2);
    });

    it('places empty slots at their canonical positions', () => {
        // Mid-table empty sections sit where the next real section starts
        // (they occupy no space); trailing ones sit at the aligned file end.
        MID_EMPTY_SLOTS.forEach((index) => {
            expect(read.slot(index)).toBe(read.slot(index + 1));
        });
        TRAILING_EMPTY_SLOTS.forEach((index) => {
            expect(read.slot(index)).toBe(moc3.length);
        });
        expect(moc3.length % 64).toBe(0);
    });
});

describe('moc3 keyform budget', () => {
    const packed = (headDx: number) =>
        new Float32Array([0, 0, 0, 0, 0, 0, headDx, 0, headDx, 0, headDx, 0, headDx, 0]);
    const sweep = (steps: number) => Array.from({ length: steps }, (_, index) => index / (steps - 1));

    it('subsamples morph keys and drops the weakest params over budget', () => {
        const model = buildFixtureModel();
        // Head moves under all 6 params with distinct magnitudes; 3^6 grids
        // would be 729 keyforms, so the weakest (Mouth, 2px) must drop.
        model.families = {
            ParamAngleX: { family: 'ParamAngleX', default: 0, values: [-30, 30], displacements: [packed(-6), packed(6)] },
            ParamAngleY: { family: 'ParamAngleY', default: 0, values: [-30, 30], displacements: [packed(-5), packed(5)] },
            ParamAngleZ: { family: 'ParamAngleZ', default: 0, values: [-30, 30], displacements: [packed(-4), packed(4)] },
            ParamEyeLOpen: { family: 'ParamEyeLOpen', default: 1, values: sweep(9), displacements: sweep(9).map(() => packed(3)) },
            ParamEyeROpen: { family: 'ParamEyeROpen', default: 1, values: sweep(9), displacements: sweep(9).map(() => packed(2.5)) },
            ParamMouthOpenY: { family: 'ParamMouthOpenY', default: 0, values: sweep(9), displacements: sweep(9).map(() => packed(2)) },
        };
        const { moc3, keyformCounts } = buildMoc3(model);
        const read = buildReader(moc3);

        // body: 1 keyform; head: 5 params x 3 keys = 243 (Mouth dropped).
        expect(keyformCounts).toEqual([1, 243]);

        const counts = read.slot(SLOT.countInfo);
        expect(read.u32(counts + 9 * 4)).toBe(244); // art mesh keyforms
        expect(read.u32(counts + 10 * 4)).toBe(3904); // 244 rows x 16-float padded stride
        expect(read.u32(counts + 13 * 4)).toBe(5); // parameter bindings (one per bound param)

        // MouthOpenY (param 5) binds nothing; EyeL still binds one.
        const pbsc = read.slot(SLOT.paramsPbsc);
        expect(read.s32(pbsc + 4 * 5)).toBe(0);
        expect(read.s32(pbsc + 4 * 3)).toBe(1);

        // EyeL is the 4th binding (0-based 3): its keys subsample to 3
        // values across [0, 0.5, 1].
        const keysBegins = read.slot(SLOT.pbKeysBegins);
        const keysCounts = read.slot(SLOT.pbKeysCounts);
        expect(read.s32(keysCounts + 3 * 4)).toBe(3);
        const eyeLKeys = read.slot(SLOT.keys) + read.s32(keysBegins + 3 * 4) * 4;
        expect(read.f32(eyeLKeys)).toBeCloseTo(0, 5);
        expect(read.f32(eyeLKeys + 4)).toBeCloseTo(0.5, 5);
        expect(read.f32(eyeLKeys + 8)).toBeCloseTo(1, 5);
    });

    it('ignores sub-threshold jitter from unrelated sweeps', () => {
        const model = buildFixtureModel();
        // EyeL sweep moves the head by only 0.1px — well under the 1% bbox
        // relevance floor — so the head must not bind it.
        model.families.ParamEyeLOpen = {
            family: 'ParamEyeLOpen',
            default: 1,
            values: [0, 1],
            displacements: [packed(0.1), packed(0.1)],
        };
        const { keyformCounts } = buildMoc3(model);
        expect(keyformCounts).toEqual([1, 3]); // head still AngleX-only
    });

    it('enumerates tensor slots column-major over ascending parameter indices (Cubism Core lookup order)', () => {
        // Two angle axes with distinguishable displacements: AngleX moves
        // x by 2px per signed key, AngleY by 10px. The Core resolves a
        // pose's tensor slot as sum(digit_i * product(radices of LOWER
        // parameter-index axes)) — the lowest param index varies FASTEST
        // (verified against a labelled fixture driven through the Web Core
        // and against VTS's own Editor-made samples). With axes (X, Y) and
        // radices (2, 2), slot i holds digits (i % 2, floor(i / 2)).
        const model = buildFixtureModel();
        const xy = (dx: number, dy: number) =>
            new Float32Array([0, 0, 0, 0, 0, 0, dx, dy, dx, dy, dx, dy, dx, dy]);
        model.families = {
            ParamAngleX: { family: 'ParamAngleX', default: 0, values: [-30, 30], displacements: [xy(-2, 0), xy(2, 0)] },
            ParamAngleY: { family: 'ParamAngleY', default: 0, values: [-30, 30], displacements: [xy(0, -10), xy(0, 10)] },
        };
        const { moc3 } = buildMoc3(model);
        const read = buildReader(moc3);
        const kpBegins = read.slot(SLOT.amKfKpBegins);
        const positions = read.slot(SLOT.kfPos);
        // Head keyforms are slots 0..3 (after the body's single slot); each
        // keyform's first vertex x reveals the AngleX digit, y the AngleY one.
        const headPose = (slot: number) => {
            const begin = read.s32(kpBegins + (1 + slot) * 4) * 4;
            return { x: read.f32(positions + begin), y: read.f32(positions + begin + 4) };
        };
        // Angle params always carry the full angleKeys [-30, 0, 30]
        // regardless of the family's two sample values, so radices are
        // (3, 3) and slot k holds digits (k % 3, floor(k / 3)).
        expect(headPose(0).x).toBeCloseTo((40 - 2 - 50) / 100, 4);
        expect(headPose(0).y).toBeCloseTo((60 - 10 - 100) / 100, 4);
        // Slot 1: digits (X=1, Y=0) -> key values (0, -30): dx 0, dy -10.
        expect(headPose(1).x).toBeCloseTo((40 - 50) / 100, 4);
        expect(headPose(1).y).toBeCloseTo((60 - 10 - 100) / 100, 4);
        // Slot 2: digits (X=2, Y=0) -> (+30, -30): dx +2.
        expect(headPose(2).x).toBeCloseTo((40 + 2 - 50) / 100, 4);
        expect(headPose(2).y).toBeCloseTo((60 - 10 - 100) / 100, 4);
        // Slot 3: digits (X=0, Y=1) -> (-30, 0): dx -2, dy 0.
        expect(headPose(3).x).toBeCloseTo((40 - 2 - 50) / 100, 4);
        expect(headPose(3).y).toBeCloseTo((60 - 100) / 100, 4);

        // Morph keys stay in value order (no swap): digit 0 closed, digit 1
        // half, digit 2 open — the rest pose lives at the top key as usual.
        const morphModel = buildFixtureModel();
        morphModel.families = {
            ParamEyeLOpen: {
                family: 'ParamEyeLOpen',
                default: 1,
                values: [0, 0.5, 1],
                displacements: [
                    xy(0, -20), // key 0 (closed): y - 20
                    xy(0, -10), // key 0.5: y - 10
                    xy(0, 0), // key 1 (open/rest): neutral
                ],
            },
        };
        const morphBuild = buildMoc3(morphModel);
        const morphRead = buildReader(morphBuild.moc3);
        const morphKp = morphRead.slot(SLOT.amKfKpBegins);
        const morphPos = morphRead.slot(SLOT.kfPos);
        const morphPose = (slot: number) => {
            const begin = morphRead.s32(morphKp + (1 + slot) * 4) * 4;
            return morphRead.f32(morphPos + begin + 4);
        };
        expect(morphPose(0)).toBeCloseTo((60 - 20 - 100) / 100, 4);
        expect(morphPose(1)).toBeCloseTo((60 - 10 - 100) / 100, 4);
        expect(morphPose(2)).toBeCloseTo((60 - 100) / 100, 4);
    });
});

describe('texture atlas packing', () => {
    it('shelves textures and remaps UVs into the atlas', () => {
        const model = buildFixtureModel();
        const wide = { width: 7, height: 2, rgba: new Uint8Array(7 * 2 * 4).fill(9) };
        model.drawables[1].texture = wide;
        const { atlas, uvs } = packTextureAtlas(model, 8);

        // body 2x2 at (0,0); head 7x2 does not fit beside it (2+7>8) and
        // wraps onto a second shelf at y=2.
        expect(atlas.height).toBe(4);
        expect(atlas.rgba[(2 * 8 + 0) * 4]).toBe(9);
        expect(atlas.rgba[(2 * 8 + 6) * 4]).toBe(9);
        // Head vertex 0 uv (0,0) maps to the wrapped shelf origin.
        expect(uvs[1][0]).toBeCloseTo(0, 5);
        expect(uvs[1][1]).toBeCloseTo(2 / 4, 5);
    });
});

describe('moc3 archive', () => {
    it('bundles a VTS-shaped folder: moc3, atlas png, and model3.json', () => {
        const archive = buildMoc3Archive(buildFixtureModel(), () => new Uint8Array([1, 2, 3]));
        const files = parseZip(archive);
        expect([...files.keys()].sort()).toEqual([
            'fixture/fixture.model3.json',
            'fixture/model.moc3',
            'fixture/texture_00.png',
        ]);

        const moc3 = files.get('fixture/model.moc3')!;
        expect([...moc3.slice(0, 4)]).toEqual([0x4d, 0x4f, 0x43, 0x33]);
        expect([...files.get('fixture/texture_00.png')!]).toEqual([1, 2, 3]);

        const manifest = JSON.parse(
            new TextDecoder().decode(files.get('fixture/fixture.model3.json')!),
        );
        expect(manifest.Version).toBe(3);
        expect(manifest.FileReferences.Moc).toBe('model.moc3');
        expect(manifest.FileReferences.Textures).toEqual(['texture_00.png']);
    });

    it('sanitizes non-ASCII model names for the VTS folder', () => {
        const model = buildFixtureModel();
        model.modelName = 'Corin 侧 顔';
        const files = parseZip(buildMoc3Archive(model, () => new Uint8Array()));
        expect([...files.keys()].every((name) => name.startsWith('Corin/'))).toBe(true);
        expect(files.has('Corin/model.moc3')).toBe(true);
    });
});
