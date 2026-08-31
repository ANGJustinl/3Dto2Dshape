import { createPoseEvaluator } from './keyforms';
import type { Live2dModel } from './model';
import type { FaceParamId, ParamAssignment } from './types';
import { createZip, type ZipEntry } from './zip';

/**
 * L2: artmesh-only .moc3 writer, format version 3.0.0 (version byte 1).
 *
 * The layout was reverse-engineered against the VTube Studio-bundled sample
 * models (hiyori/tororo) and the community spec (OpenL2D moc3ingbird
 * moc3.hexpat): the section table at 0x40 is FLATTENED — one u32 slot per
 * member array across all sections in declaration order (101 slots for
 * version 1, including per-section runtime spaces and inline ID arrays).
 * Data starts at 0x7C0; countInfo/canvas are inline structs, everything else
 * is pointed-to element arrays; empty sections point at EOF. Coordinates are
 * pixels around the canvas center with pixelsPerUnit = canvas width, UVs are
 * normalized with v up, and uv/keyformPosition counts and begins are counted
 * in FLOATS (2 per element).
 *
 * Grid policy: a param binds only when it moves the drawable beyond 1% of
 * its neutral bounds; morph sweeps are subsampled to 3 keys; the tensor
 * product of bound params must fit 512 keyforms per artmesh, dropping the
 * weakest-motion params first (their motion exports as static). Positions
 * come from the additive evaluator; re-baking the grid against the 3D model
 * is the upgrade path.
 *
 * Binding layer (verified rendering in VTube Studio on a live export):
 * tensor slots are enumerated FIRST-outer (pool axis 0 slowest — VTS's
 * native Core order; the Web Core 5.x reads last-outer, so Web-side
 * previews of driven poses show swapped tensor axes by design), every
 * bound parameter owns exactly ONE shared parameterBinding (pbsbi/pbsc
 * 1:1), artmeshes with the same param set share one keyformBinding,
 * keyform blocks in the kfPos pool are padded to 16-float strides, and
 * every parameter carries decimals = 3 (decimals 0 made the native Core
 * quantize morph values into steps).
 */

const SLOT_COUNT = 101;
const DATA_START = 0x7c0;
/** Per-artmesh tensor budget: 3^5 keyforms with default 3-key grids. */
const MAX_KEYFORMS_PER_ARTMESH = 512;

/** Flattened slot indices (version 1 declaration order, spec-verified). */
const SLOT = {
    countInfo: 0,
    canvas: 1,
    partsRuntime: 2,
    partsIds: 3,
    partsKbsi: 4,
    partsKsbi: 5,
    partsKsc: 6,
    partsVisible: 7,
    partsEnabled: 8,
    partsParentPart: 9,
    amRuntime0: 29,
    amRuntime1: 30,
    amRuntime2: 31,
    amRuntime3: 32,
    amIds: 33,
    amKbsi: 34,
    amKsbi: 35,
    amKsc: 36,
    amVisible: 37,
    amEnabled: 38,
    amParentPart: 39,
    amParentDeformer: 40,
    amTextureNos: 41,
    amFlags: 42,
    amVertexCounts: 43,
    amUvBegins: 44,
    amPiBegins: 45,
    amPiCounts: 46,
    amMaskBegins: 47,
    amMaskCounts: 48,
    paramsRuntime: 49,
    paramsIds: 50,
    paramsMax: 51,
    paramsMin: 52,
    paramsDefault: 53,
    paramsRepeat: 54,
    paramsDecimals: 55,
    paramsPbsbi: 56,
    paramsPbsc: 57,
    partKfDrawOrders: 58,
    amKfOpacities: 68,
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
    masks: 80,
    groupsObjBegins: 81,
    groupsObjCounts: 82,
    groupsObjTotalCounts: 83,
    groupsMaxDrawOrders: 84,
    groupsMinDrawOrders: 85,
    groupObjectsTypes: 86,
    groupObjectsIndices: 87,
    groupObjectsSelfIndices: 88,
} as const;

class ByteWriter {
    private buffer = new ArrayBuffer(1 << 16);
    private view = new DataView(this.buffer);
    private length = 0;

    private ensure(extra: number) {
        if (this.length + extra <= this.buffer.byteLength) {
            return;
        }
        let capacity = this.buffer.byteLength;
        while (capacity < this.length + extra) {
            capacity *= 2;
        }
        const next = new ArrayBuffer(capacity);
        new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.length));
        this.buffer = next;
        this.view = new DataView(this.buffer);
    }

    get offset() {
        return this.length;
    }

    u8(value: number) {
        this.ensure(1);
        this.view.setUint8(this.length, value);
        this.length += 1;
    }

    u32(value: number) {
        this.ensure(4);
        this.view.setUint32(this.length, value >>> 0, true);
        this.length += 4;
    }

    s32(value: number) {
        this.ensure(4);
        this.view.setInt32(this.length, value | 0, true);
        this.length += 4;
    }

    f32(value: number) {
        this.ensure(4);
        this.view.setFloat32(this.length, value, true);
        this.length += 4;
    }

    s16(value: number) {
        this.ensure(2);
        this.view.setInt16(this.length, value | 0, true);
        this.length += 2;
    }

    bytes(data: Uint8Array) {
        this.ensure(data.byteLength);
        new Uint8Array(this.buffer, this.length, data.byteLength).set(data);
        this.length += data.byteLength;
    }

    align4() {
        while (this.length % 4 !== 0) {
            this.u8(0);
        }
    }

    align16() {
        while (this.length % 16 !== 0) {
            this.u8(0);
        }
    }

    alignTo(bytes: number) {
        while (this.length % bytes !== 0) {
            this.u8(0);
        }
    }

    patchU32(position: number, value: number) {
        this.view.setUint32(position, value >>> 0, true);
    }

    toUint8Array() {
        return new Uint8Array(this.buffer, 0, this.length).slice();
    }
}

/** Fixed 64-byte ID: UTF-8 encoded, truncated on a sequence boundary. */
const fixedIdBytes = (id: string) => {
    const encoded = new TextEncoder().encode(id);
    if (encoded.byteLength <= 64) {
        const out = new Uint8Array(64);
        out.set(encoded);
        return out;
    }
    let cut = 64;
    // Back off to a UTF-8 lead byte so no multi-byte sequence is split.
    while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) {
        cut -= 1;
    }
    return encoded.slice(0, cut);
};

type ArtMeshPlan = {
    drawableIndex: number;
    /** Model parameter indices this artmesh responds to. */
    parameterIndices: number[];
    /** Grid assignments over parameterIndices' key values (in model order). */
    keyformAssignments: ParamAssignment[];
};

const familyMotionMagnitude = (
    model: Live2dModel,
    drawableIndex: number,
    offsets: number[],
    family: string,
) => {
    const keyforms = model.families[family];
    if (!keyforms) {
        return 0;
    }
    const begin = offsets[drawableIndex];
    const end = begin + model.drawables[drawableIndex].vertexCount * 2;
    let maxMagnitude = 0;
    keyforms.displacements.forEach((block) => {
        for (let index = begin; index < end; index += 1) {
            maxMagnitude = Math.max(maxMagnitude, Math.abs(block[index]));
        }
    });
    return maxMagnitude;
};

const drawableNeutralDiagonal = (neutralPositions: Float32Array) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < neutralPositions.length; index += 2) {
        minX = Math.min(minX, neutralPositions[index]);
        maxX = Math.max(maxX, neutralPositions[index]);
        minY = Math.min(minY, neutralPositions[index + 1]);
        maxY = Math.max(maxY, neutralPositions[index + 1]);
    }
    return Math.hypot(maxX - minX, maxY - minY);
};

/** Evenly subsamples key values down to `cap`, always keeping min/max/default. */
const subsampleKeys = (values: number[], defaultValue: number, cap: number) => {
    if (values.length <= cap) {
        return values;
    }
    const indices = new Set<number>();
    for (let step = 0; step < cap; step += 1) {
        indices.add(Math.round((step * (values.length - 1)) / (cap - 1)));
    }
    let defaultIndex = 0;
    values.forEach((value, index) => {
        if (Math.abs(value - defaultValue) < Math.abs(values[defaultIndex] - defaultValue)) {
            defaultIndex = index;
        }
    });
    indices.add(defaultIndex);
    return [...indices].sort((left, right) => left - right).map((index) => values[index]);
};

/** Unique ascending key values for a param, always including its default. */
const keyValuesForParam = (
    model: Live2dModel,
    paramIndex: number,
    angleKeys: number[],
    maxMorphKeys: number,
) => {
    const param = model.params[paramIndex];
    if (param.id === 'ParamAngleX' || param.id === 'ParamAngleY' || param.id === 'ParamAngleZ') {
        return [...new Set([...angleKeys, param.default])].sort((left, right) => left - right);
    }
    const keyforms = model.families[param.id];
    const values = keyforms
        ? subsampleKeys(keyforms.values, param.default, maxMorphKeys)
        : [param.min, param.max];
    return [...new Set([...values, param.default])].sort((left, right) => left - right);
};

export type Moc3BuildResult = {
    moc3: Uint8Array;
    /** Per-artmesh keyform counts, for export reporting. */
    keyformCounts: number[];
};

export const buildMoc3 = (
    model: Live2dModel,
    options: { angleKeys?: number[]; maxMorphKeys?: number } = {},
): Moc3BuildResult => {
    const { angleKeys = [-30, 0, 30], maxMorphKeys = 3 } = options;
    const writer = new ByteWriter();
    const slotTargets = new Array<number>(SLOT_COUNT).fill(-1);
    const setSlot = (slot: number, target: number) => {
        slotTargets[slot] = target;
    };

    /**
     * Appends an element array. Placement follows the canonical layout
     * every real export uses (verified by simulating the VTS sample models
     * byte-for-byte): each array starts 64-byte aligned, except ID arrays
     * which directly follow their section's runtime space.
     */
    const appendArray = (write: () => void, followsRuntime = false) => {
        if (!followsRuntime) {
            writer.alignTo(64);
        }
        const start = writer.offset;
        write();
        return start;
    };
    const s32Array = (values: number[]) =>
        appendArray(() => values.forEach((value) => writer.s32(value)));
    const u32Array = (values: number[]) =>
        appendArray(() => values.forEach((value) => writer.u32(value)));
    const f32Array = (values: number[]) =>
        appendArray(() => values.forEach((value) => writer.f32(value)));
    const zeroBytes = (count: number) =>
        appendArray(() => {
            for (let index = 0; index < count; index += 1) {
                writer.u8(0);
            }
        });
    const idsArray = (ids: string[]) =>
        appendArray(() => ids.forEach((entry) => writer.bytes(fixedIdBytes(entry))), true);

    // ---- Header + slot table ----
    writer.bytes(new Uint8Array([0x4d, 0x4f, 0x43, 0x33])); // "MOC3"
    writer.u8(1); // version 3.0.0 (the layout VTS's own sample models use)
    writer.u8(0); // little endian
    while (writer.offset < 0x40) {
        writer.u8(0);
    }
    const slotPositions: number[] = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        slotPositions.push(writer.offset);
        writer.u32(0);
    }
    while (writer.offset < DATA_START) {
        writer.u8(0);
    }

    // ---- Parameter key plan ----
    const keyValuesByParamIndex = model.params.map((_param, paramIndex) =>
        keyValuesForParam(model, paramIndex, angleKeys, maxMorphKeys),
    );

    const angleXParamIndex = model.params.findIndex((param) => param.id === 'ParamAngleX');
    const angleXKeys =
        angleXParamIndex >= 0 ? keyValuesByParamIndex[angleXParamIndex] : [0];

    // ---- ArtMesh plans ----
    // A param binds when it moves the drawable by more than 1% of the
    // drawable's neutral bounds (min 1px); the tensor product of bound params'
    // keys must fit the keyform budget, dropping the weakest params first.
    const displacementOffsets: number[] = [];
    let displacementCursor = 0;
    model.drawables.forEach((drawable) => {
        displacementOffsets.push(displacementCursor);
        displacementCursor += drawable.vertexCount * 2;
    });
    const plans: ArtMeshPlan[] = model.drawables.map((drawable, drawableIndex) => {
        const relevance = Math.max(1, drawableNeutralDiagonal(drawable.neutralPositions) * 0.01);
        const candidates = model.params
            .map((param, paramIndex) => ({
                paramIndex,
                magnitude: familyMotionMagnitude(model, drawableIndex, displacementOffsets, param.id),
            }))
            .filter((candidate) => candidate.magnitude > relevance)
            .sort((left, right) => right.magnitude - left.magnitude);

        const parameterIndices: number[] = [];
        let product = 1;
        candidates.forEach((candidate) => {
            const keyCount = keyValuesByParamIndex[candidate.paramIndex].length;
            if (product * keyCount > MAX_KEYFORMS_PER_ARTMESH) {
                return; // over budget: this and every weaker param stays static
            }
            parameterIndices.push(candidate.paramIndex);
            product *= keyCount;
        });
        if (parameterIndices.length === 0 && angleXParamIndex >= 0) {
            // Motionless meshes still bind AngleX: their draw-order keyforms
            // must track the per-pose ranking or their constant order collides
            // with a moving mesh's rank (ties re-freeze the stacking).
            parameterIndices.push(angleXParamIndex);
        }
        parameterIndices.sort((left, right) => left - right);

        const defaults = {} as ParamAssignment;
        model.params.forEach((param) => {
            defaults[param.id] = param.default;
        });
        // Tensor slot enumeration must match the Cubism Core's keyform
        // lookup, which is COLUMN-MAJOR over the binding axes sorted by
        // parameter index (the lowest param index varies FASTEST):
        // slot = sum(digit_i * product(radices of lower-index axes)).
        // Verified against a per-axis-labelled fixture driven through the
        // Web Core 5.1 AND against VTS's own Editor-made samples (tororo
        // binds [AngleY, AngleX] in pbi but reads as if sorted to
        // [AngleX, AngleY] with X fastest). A row-major enumeration makes
        // VTS shred every multi-axis mesh the moment it moves.
        const keyformAssignments: ParamAssignment[] = [];
        const totalSlots = parameterIndices.reduce(
            (product, paramIndex) => product * keyValuesByParamIndex[paramIndex].length,
            1,
        );
        const radices = parameterIndices.map((paramIndex) => keyValuesByParamIndex[paramIndex].length);
        for (let linear = 0; linear < totalSlots; linear += 1) {
            const assignment = { ...defaults };
            let divisor = 1;
            parameterIndices.forEach((paramIndex, axis) => {
                const values = keyValuesByParamIndex[paramIndex];
                assignment[model.params[paramIndex].id as FaceParamId] =
                    values[Math.floor(linear / divisor) % radices[axis]];
                divisor *= radices[axis];
            });
            keyformAssignments.push(assignment);
        }
        return { drawableIndex, parameterIndices, keyformAssignments };
    });

    const totalArtMeshKeyforms = plans.reduce((total, plan) => total + plan.keyformAssignments.length, 0);
    const bindingPlans = plans.filter((plan) => plan.parameterIndices.length > 0);

    // ---- Mask table ----
    // Per masked drawable: [begin, count] into the shared masker-index pool
    // (indices of the masking drawables). Masked artmeshes also carry the
    // Editor flag bit 0x08 on top of the constant 4.
    const idToDrawableIndex = new Map<string, number>();
    model.drawables.forEach((drawable, index) => {
        idToDrawableIndex.set(drawable.id, index);
    });
    const maskPool: number[] = [];
    const maskBegins: number[] = [];
    const maskCounts: number[] = [];
    const maskedFlags: Array<number | null> = model.drawables.map(() => null);
    model.drawables.forEach((drawable, index) => {
        const maskerIndices = (drawable.maskIds ?? [])
            .map((id) => idToDrawableIndex.get(id))
            .filter((value): value is number => value !== undefined);
        maskBegins.push(maskPool.length);
        maskCounts.push(maskerIndices.length);
        maskerIndices.forEach((maskerIndex) => maskPool.push(maskerIndex));
        if (maskerIndices.length > 0) {
            maskedFlags[index] = 4 | 0x08;
        }
    });
    const totalMaskIndices = maskPool.length;

    // Binding graph follows the sample models exactly (verified in VTube
    // Studio): ONE parameterBinding PER PARAMETER, shared by every artmesh
    // that binds it (params.pbsbi/pbsc = 1:1), one keyformBinding per
    // DISTINCT bound-param-set shared across artmeshes, and the pbi pool
    // listing each keyformBinding's parameterBindings in param order.
    // Writing one pb per (param, artmesh) — a previous revision — drives
    // VTS's native Core into garbage slot selection while the Web Core
    // still evaluates it exactly, so the shared-pb shape is load-bearing.
    const boundParamIndices = model.params
        .map((_param, paramIndex) => paramIndex)
        .filter((paramIndex) => bindingPlans.some((plan) => plan.parameterIndices.includes(paramIndex)));
    const pbIndexOfParam = new Map<number, number>();
    boundParamIndices.forEach((paramIndex, rank) => {
        pbIndexOfParam.set(paramIndex, rank);
    });
    const parameterBindingCount = boundParamIndices.length;
    // 16-float-aligned stride per keyform in the kfPos pool (the sample
    // models pad every keyform block up to a multiple of 16 floats).
    const keyformStride = (vertexCount: number) => Math.ceil((vertexCount * 2) / 16) * 16;
    const totalKeyformVertexFloats = plans.reduce(
        (total, plan) =>
            total +
            plan.keyformAssignments.length *
                keyformStride(model.drawables[plan.drawableIndex].vertexCount),
        0,
    );
    const totalVertexFloats = model.drawables.reduce(
        (total, drawable) => total + drawable.vertexCount * 2,
        0,
    );
    const totalIndices = model.drawables.reduce((total, drawable) => total + drawable.triangles.length, 0);
    const totalKeys = boundParamIndices.reduce(
        (total, paramIndex) => total + keyValuesByParamIndex[paramIndex].length,
        0,
    );
    // Artmeshes sharing the same bound-param set share one keyformBinding.
    const keyformBindingIndexOf = new Map<number, number>();
    const kbParamSets: number[][] = [];
    bindingPlans.forEach((plan) => {
        const setKey = plan.parameterIndices.join(',');
        let rank = kbParamSets.findIndex((set) => set.join(',') === setKey);
        if (rank < 0) {
            kbParamSets.push([...plan.parameterIndices]);
            rank = kbParamSets.length - 1;
        }
        keyformBindingIndexOf.set(plan.drawableIndex, rank + 1);
    });

    // ---- Part draw order keyforms (head-turn occlusion) ----
    // Every part carries keyforms bound to AngleX whose draw orders rank the
    // whole model by evaluated median depth at that angle. Static part orders
    // freeze the head-turn stacking: back hair never slides behind the face.
    // With no depth data the evaluator returns neutral depths, degrading to
    // the neutral stacking.
    const partKsc = angleXParamIndex >= 0 ? angleXKeys.length : 1;
    const partsSetKey = String(angleXParamIndex);
    let partsKbIndex = kbParamSets.findIndex((set) => set.join(',') === partsSetKey);
    if (partsKbIndex < 0) {
        kbParamSets.push([angleXParamIndex]);
        partsKbIndex = kbParamSets.length - 1;
    }
    partsKbIndex += 1; // kb[0] is the shared empty binding
    const depthRanksByCell: number[][] = [];
    const partDrawOrders: number[] = [];
    for (let cell = 0; cell < partKsc; cell += 1) {
        // Constant neutral permutation: this model's neutral order isolates
        // every hair piece between non-hair drawables, so ANY pose-driven
        // reorder crosses a non-hair boundary (bangs behind the face = bald,
        // bear over the chest). Head-turn occlusion is carried by the
        // displacement field instead.
        depthRanksByCell.push(model.drawables.map((drawable) => drawable.renderOrder));
    }
    // Per-pose rank lookup shared with the artmesh keyform draw orders:
    // the Core exposes ARTMESH-level render orders (part tables never move
    // them), so this table is the one that actually re-orders at runtime.
    const ranksByAngleValue = new Map<number, number[]>();
    if (angleXParamIndex >= 0) {
        angleXKeys.forEach((value, cell) => {
            ranksByAngleValue.set(value, depthRanksByCell[cell]);
        });
    }
    // part-major layout: part m's keyforms occupy [m * partKsc, (m + 1) * partKsc).
    model.drawables.forEach((_drawable, mesh) => {
        depthRanksByCell.forEach((rankOfMesh) => {
            partDrawOrders.push(
                Math.round((rankOfMesh[mesh] * 1000) / Math.max(1, model.drawables.length - 1)),
            );
        });
    });

    // ---- 0: CountInfoTable (23 counts + padding to a FIXED 128-byte
    // section; the checker expects the canvas section 128 bytes after the
    // count table, as in every real export). ----
    const countInfo = appendArray(() => {
        [
            model.drawables.length, // parts
            0, // deformers
            0, // warp deformers
            0, // rotation deformers
            model.drawables.length, // art meshes
            model.params.length, // parameters
            model.drawables.length * partKsc, // part keyforms (AngleX-bound)
            0, // warp deformer keyforms
            0, // rotation deformer keyforms
            totalArtMeshKeyforms, // art mesh keyforms
            totalKeyformVertexFloats, // keyform positions (float count)
            kbParamSets.reduce((total, set) => total + set.length, 0), // parameter binding indices
            kbParamSets.length + 1, // keyform bindings (dummy + real)
            parameterBindingCount, // parameter bindings
            totalKeys, // keys
            totalVertexFloats, // uvs (float count)
            totalIndices, // position indices
            totalMaskIndices, // drawable masks
            1, // draw order groups
            model.drawables.length, // draw order group objects
            0, // glue
            0, // glue info
            0, // glue keyforms
        ].forEach((count) => writer.u32(count));
        for (let index = 0; index < 128 - 23 * 4; index += 1) {
            writer.u8(0);
        }
    });
    setSlot(SLOT.countInfo, countInfo);

    // ---- 1: CanvasInfo (positions are pixels around center; ppu = width) ----
    const canvas = appendArray(() => {
        writer.f32(model.viewport.width); // pixels per unit
        writer.f32(model.viewport.width / 2); // origin x (canvas center)
        writer.f32(model.viewport.height / 2); // origin y
        writer.f32(model.viewport.width);
        writer.f32(model.viewport.height);
        writer.u8(0); // flags
        for (let index = 0; index < 43; index += 1) {
            writer.u8(0);
        }
    });
    setSlot(SLOT.canvas, canvas);

    // ---- 2-9: Parts (1:1 with drawables). Each part binds AngleX and
    // carries one draw-order keyform per AngleX key, so the head-turn
    // stacking re-ranks by evaluated depth (see the part keyform block). ----
    setSlot(SLOT.partsRuntime, zeroBytes(model.drawables.length * 8));
    setSlot(SLOT.partsIds, idsArray(model.drawables.map((drawable) => `P${drawable.id}`)));
    setSlot(SLOT.partsKbsi, s32Array(model.drawables.map(() => partsKbIndex)));
    setSlot(
        SLOT.partsKsbi,
        s32Array(model.drawables.map((_drawable, index) => index * partKsc)),
    );
    setSlot(SLOT.partsKsc, s32Array(model.drawables.map(() => partKsc)));
    setSlot(SLOT.partsVisible, u32Array(model.drawables.map(() => 1)));
    setSlot(SLOT.partsEnabled, u32Array(model.drawables.map(() => 1)));
    setSlot(SLOT.partsParentPart, s32Array(model.drawables.map(() => -1)));
    // 10-28: deformers/warp/rotation all empty (slots stay -1 -> EOF).

    // ---- 29-48: ArtMeshes ----
    // Runtime spaces are raw 8N bytes placed 64-aligned (the padding seen
    // in real files is placement alignment, not array padding); ID arrays
    // follow their runtime space directly.
    setSlot(SLOT.amRuntime0, zeroBytes(model.drawables.length * 8));
    setSlot(SLOT.amRuntime1, zeroBytes(model.drawables.length * 8));
    setSlot(SLOT.amRuntime2, zeroBytes(model.drawables.length * 8));
    setSlot(SLOT.amRuntime3, zeroBytes(model.drawables.length * 8));
    setSlot(SLOT.amIds, idsArray(model.drawables.map((drawable) => `D${drawable.id}`)));

    // Keyform bindings: kb[0] is the empty binding referenced by every
    // static artmesh (and all parts); kbParamSets (computed above) dedupes
    // the real bindings per bound-param set.
    const keyformBegins: number[] = [];
    let keyformCursor = 0;
    plans.forEach((plan) => {
        keyformBegins.push(keyformCursor);
        keyformCursor += plan.keyformAssignments.length;
    });
    const uvFloatBegins: number[] = [];
    const piBegins: number[] = [];
    let vertexCursor = 0;
    let indexCursor = 0;
    model.drawables.forEach((drawable) => {
        uvFloatBegins.push(vertexCursor * 2);
        piBegins.push(indexCursor);
        vertexCursor += drawable.vertexCount;
        indexCursor += drawable.triangles.length;
    });

    setSlot(
        SLOT.amKbsi,
        s32Array(model.drawables.map((_drawable, index) => keyformBindingIndexOf.get(index) ?? 0)),
    );
    setSlot(SLOT.amKsbi, s32Array(keyformBegins));
    setSlot(SLOT.amKsc, s32Array(plans.map((plan) => plan.keyformAssignments.length)));
    setSlot(SLOT.amVisible, u32Array(model.drawables.map(() => 1)));
    setSlot(SLOT.amEnabled, u32Array(model.drawables.map(() => 1)));
    setSlot(
        SLOT.amParentPart,
        s32Array(model.drawables.map((_drawable, index) => index)),
    );
    setSlot(SLOT.amParentDeformer, s32Array(model.drawables.map(() => -1)));
    setSlot(SLOT.amTextureNos, u32Array(model.drawables.map(() => 0)));
    // drawableFlags is one BYTE per artmesh (not u32). Editor files set
    // constant flag 4 on every artmesh (tororo/hiyori: uniform 4); masked
    // artmeshes additionally carry bit 0x08 (akari: 12 on its maskees).
    setSlot(
        SLOT.amFlags,
        appendArray(() =>
            model.drawables.forEach((_drawable, index) => writer.u8(maskedFlags[index] ?? 4)),
        ),
    );
    setSlot(
        SLOT.amVertexCounts,
        s32Array(model.drawables.map((drawable) => drawable.vertexCount)),
    );
    setSlot(SLOT.amUvBegins, s32Array(uvFloatBegins));
    setSlot(SLOT.amPiBegins, s32Array(piBegins));
    setSlot(
        SLOT.amPiCounts,
        s32Array(model.drawables.map((drawable) => drawable.triangles.length)),
    );
    setSlot(SLOT.amMaskBegins, s32Array(maskBegins));
    setSlot(SLOT.amMaskCounts, s32Array(maskCounts));

    // ---- 49-57: Parameters ----
    setSlot(SLOT.paramsRuntime, zeroBytes(model.params.length * 8));
    setSlot(SLOT.paramsIds, idsArray(model.params.map((param) => param.id)));
    setSlot(SLOT.paramsMax, f32Array(model.params.map((param) => param.max)));
    setSlot(SLOT.paramsMin, f32Array(model.params.map((param) => param.min)));
    setSlot(SLOT.paramsDefault, f32Array(model.params.map((param) => param.default)));
    setSlot(SLOT.paramsRepeat, s32Array(model.params.map(() => 0)));
    // decimals = 3 on every parameter: the sample models carry 3 and the
    // native Core's parameter quantization follows it (writing 0 made
    // morph params evaluate as stepped values).
    setSlot(SLOT.paramsDecimals, s32Array(model.params.map(() => 3)));
    // Every bound parameter owns exactly ONE parameterBinding (its shared
    // key list); unbound params use begin 0 / count 0 (a -1 sentinel trips
    // the consistency checker even though the sample models carry it).
    setSlot(
        SLOT.paramsPbsbi,
        s32Array(model.params.map((_param, paramIndex) => pbIndexOfParam.get(paramIndex) ?? 0)),
    );
    setSlot(
        SLOT.paramsPbsc,
        s32Array(model.params.map((_param, paramIndex) => (pbIndexOfParam.has(paramIndex) ? 1 : 0))),
    );

    // ---- 58: PartKeyforms (draw order per part per AngleX key; cell k of
    // part m lives at m * partKsc + k, matching parts.ksbi/ksc above) ----
    setSlot(SLOT.partKfDrawOrders, f32Array(partDrawOrders));
    // 59-67: deformer keyforms empty.

    // ---- 68-70: ArtMeshKeyforms ----
    setSlot(
        SLOT.amKfOpacities,
        f32Array(plans.flatMap((plan) => plan.keyformAssignments.map(() => 1))),
    );
    // Constant neutral rank per mesh across all keyforms.
    const orderScale = Math.max(1, model.drawables.length - 1);
    const amKfOrderValues = plans.flatMap((plan) =>
        plan.keyformAssignments.map(() =>
            Math.round((model.drawables[plan.drawableIndex].renderOrder * 1000) / orderScale),
        ),
    );
    setSlot(
        SLOT.amKfDrawOrders,
        f32Array(amKfOrderValues),
    );
    // kpBegins are FLOAT offsets into the kfPos pool, and every keyform
    // block is padded to a multiple of 16 floats (the sample models'
    // stride convention).
    const kpFloatBegins: number[] = [];
    let keyformFloatCursor = 0;
    plans.forEach((plan) => {
        const stride = keyformStride(model.drawables[plan.drawableIndex].vertexCount);
        plan.keyformAssignments.forEach(() => {
            kpFloatBegins.push(keyformFloatCursor);
            keyformFloatCursor += stride;
        });
    });
    setSlot(SLOT.amKfKpBegins, s32Array(kpFloatBegins));

    // ---- 71: KeyformPositions ----
    // Positions are stored in MODEL UNITS relative to the canvas center
    // (raw pixel offset / pixelsPerUnit), Y pointing DOWN. The Core hands
    // these values back out multiplied by ppu — verified against tororo:
    // default-pose extents of ~929 px on its ppu-2000 canvas come back as
    // ±0.46 units, which every Core consumer rescales by 1/ppu for display.
    // Storing raw pixels instead makes the Core return pixel-magnitude
    // "units" and the character renders ppu-times too large (the
    // giant-blob failure mode in VTS).
    const halfWidth = model.viewport.width / 2;
    const halfHeight = model.viewport.height / 2;
    const pixelsPerUnit = model.viewport.width;
    const neutralPositions = model.drawables.map((drawable) => drawable.neutralPositions);
    const poseEvaluator = createPoseEvaluator(model.drawables, neutralPositions, model.families);
    const poseOutputs = model.drawables.map((drawable) => new Float32Array(drawable.vertexCount * 2));
    setSlot(
        SLOT.kfPos,
        appendArray(() => {
            plans.forEach((plan) => {
                const drawable = model.drawables[plan.drawableIndex];
                const stride = keyformStride(drawable.vertexCount);
                plan.keyformAssignments.forEach((assignment) => {
                    poseEvaluator.evaluate(assignment, poseOutputs);
                    const output = poseOutputs[plan.drawableIndex];
                    for (let v = 0; v < drawable.vertexCount; v += 1) {
                        writer.f32((output[v * 2] - halfWidth) / pixelsPerUnit);
                        writer.f32((output[v * 2 + 1] - halfHeight) / pixelsPerUnit);
                    }
                    for (let pad = drawable.vertexCount * 2; pad < stride; pad += 1) {
                        writer.f32(0);
                    }
                });
            });
        }),
    );

    // ---- 72-74: ParameterBindingIndices + KeyformBindings ----
    // The pbi pool carries one contiguous slice per keyformBinding (kb[0] =
    // {0,0} is the shared empty binding); each slice lists the shared
    // parameterBindings of that param-set in param order.
    setSlot(
        SLOT.pbi,
        s32Array(
            kbParamSets.flatMap((parameterIndices) =>
                parameterIndices.map((paramIndex) => pbIndexOfParam.get(paramIndex) ?? 0),
            ),
        ),
    );
    const kbBegins: number[] = [0];
    const kbCounts: number[] = [0];
    let pbCursor = 0;
    kbParamSets.forEach((parameterIndices) => {
        kbBegins.push(pbCursor);
        kbCounts.push(parameterIndices.length);
        pbCursor += parameterIndices.length;
    });
    setSlot(SLOT.kbPbisbi, s32Array(kbBegins));
    setSlot(SLOT.kbPbisc, s32Array(kbCounts));

    // ---- 75-77: ParameterBindings + Keys ----
    // One parameterBinding per bound parameter, each owning its key slice.
    const pbKeysBegins: number[] = [];
    const pbKeysCounts: number[] = [];
    let keyCursor = 0;
    boundParamIndices.forEach((paramIndex) => {
        pbKeysBegins.push(keyCursor);
        pbKeysCounts.push(keyValuesByParamIndex[paramIndex].length);
        keyCursor += keyValuesByParamIndex[paramIndex].length;
    });
    setSlot(SLOT.pbKeysBegins, s32Array(pbKeysBegins));
    setSlot(SLOT.pbKeysCounts, s32Array(pbKeysCounts));
    setSlot(
        SLOT.keys,
        f32Array(boundParamIndices.flatMap((paramIndex) => keyValuesByParamIndex[paramIndex])),
    );

    // ---- 78: UVs ----
    // Stored as-is from the app's layout. VTS/Cubism samples these with its
    // own v inversion, which lands on the intended texels for the app's
    // top-down convention; flipping here double-flips and every mesh samples
    // the vertically mirrored atlas region (vanishing meshes + scrap
    // fragments). Verified end-to-end against VTube Studio.
    setSlot(
        SLOT.uvs,
        appendArray(() => {
            model.drawables.forEach((drawable) => {
                for (let v = 0; v < drawable.vertexCount; v += 1) {
                    writer.f32(drawable.uvs[v * 2]);
                    writer.f32(drawable.uvs[v * 2 + 1]);
                }
            });
        }),
    );

    // ---- 79: PositionIndices (s16, per-artmesh local) ----
    // Consumers cull one triangle orientation, and Editor files are uniformly
    // CCW in the Core's exposed space (tororo: every triangle of all 56
    // meshes). Our meshes inherit mixed winding from the 3D surface
    // direction leaking through the projection, which those consumers render
    // as cull holes and vanishing meshes. Normalize every triangle to CCW
    // measured on neutral positions as stored — verified end-to-end through
    // the real Core (scripts/winding-core.test.ts) that this yields CCW in
    // the Core's exposed space for both input orientations.
    const triangleIsFrontFacing = (
        positions: Float32Array,
        a: number,
        b: number,
        c: number,
    ) => {
        const ax = positions[a * 2];
        const ay = positions[a * 2 + 1];
        const bx = positions[b * 2];
        const by = positions[b * 2 + 1];
        const cx = positions[c * 2];
        const cy = positions[c * 2 + 1];
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= 0;
    };
    model.drawables.forEach((drawable) => {
        drawable.triangles.forEach((index) => {
            if (index > 32767) {
                throw new Error(
                    `Drawable ${drawable.id} vertex index ${index} exceeds the s16 limit; split the mesh before moc3 export.`,
                );
            }
        });
    });
    setSlot(
        SLOT.positionIndices,
        appendArray(() => {
            model.drawables.forEach((drawable) => {
                for (let t = 0; t < drawable.triangles.length; t += 3) {
                    const a = drawable.triangles[t];
                    const b = drawable.triangles[t + 1];
                    const c = drawable.triangles[t + 2];
                    const front = triangleIsFrontFacing(drawable.neutralPositions, a, b, c);
                    writer.s16(a);
                    writer.s16(front ? b : c);
                    writer.s16(front ? c : b);
                }
            });
        }),
    );

    // ---- 80: Mask sources pool (one s32 masker-artmesh index per entry,
    // addressed by am.maskBegins/maskCounts) ----
    if (maskPool.length > 0) {
        setSlot(SLOT.masks, s32Array(maskPool));
    }

    // ---- 81-88: DrawOrderGroups ----
    // Every real export carries exactly one group covering all artmeshes;
    // glue and masks are optional (sample models ship with them at 0) but
    // the consistency checker rejects files without the group structure.
    const drawOrders = model.drawables.map((drawable) => drawable.renderOrder);
    const orderedArtMeshIndices = model.drawables
        .map((_drawable, index) => index)
        .sort((left, right) => drawOrders[left] - drawOrders[right]);
    setSlot(SLOT.groupsObjBegins, s32Array([0]));
    setSlot(SLOT.groupsObjCounts, s32Array([model.drawables.length]));
    setSlot(SLOT.groupsObjTotalCounts, s32Array([model.drawables.length]));
    // Real files store these bounds as integer bits in the f32 slots, and
    // they bound the KEYFORM draw-order value range (hiyori: 200..1000 over
    // its keyform values 100..1000) — NOT the neutral renderOrder range. A
    // 0..0 pair collapses every keyform draw order to a tie and freezes the
    // stacking for good (the "head turn does nothing" failure).
    setSlot(
        SLOT.groupsMaxDrawOrders,
        appendArray(() => writer.u32(Math.max(...partDrawOrders, ...amKfOrderValues, 1000))),
    );
    setSlot(
        SLOT.groupsMinDrawOrders,
        appendArray(() => writer.u32(Math.min(...partDrawOrders, ...amKfOrderValues, 0))),
    );
    setSlot(SLOT.groupObjectsTypes, u32Array(model.drawables.map(() => 0)));
    setSlot(SLOT.groupObjectsIndices, s32Array(orderedArtMeshIndices));
    setSlot(SLOT.groupObjectsSelfIndices, s32Array(model.drawables.map(() => -1)));
    // 80, 89-100: masks / glue empty.

    // ---- Fixups ----
    // File size must be 64-aligned and cover the last section (empirically
    // bisected against the real Core; the canonical layout simulator
    // reproduces every sample's exact size this way). Empty slots sit at
    // their canonical position: the next real section's placement (empty
    // sections occupy no space), or the aligned end for trailing ones.
    while (writer.offset % 64 !== 0) {
        writer.u8(0);
    }
    const fileEnd = writer.offset;
    let nextTarget = fileEnd;
    for (let index = SLOT_COUNT - 1; index >= 0; index -= 1) {
        if (slotTargets[index] >= 0) {
            nextTarget = slotTargets[index];
        } else {
            slotTargets[index] = nextTarget;
        }
    }
    slotTargets.forEach((target, index) => {
        writer.patchU32(slotPositions[index], target);
    });

    return {
        moc3: writer.toUint8Array(),
        keyformCounts: plans.map((plan) => plan.keyformAssignments.length),
    };
};

/**
 * Packs the drawable textures into one shelf atlas and remaps UVs.
 *
 * Shelves sit `pad` pixels apart and every shelf's border texels are bled
 * `bleed` pixels outward into that gap: mesh boundary triangles sample past
 * their UV islands, and without bleed they read the transparent gap or a
 * neighbour's texels, fraying every silhouette.
 */
export const packTextureAtlas = (
    model: Live2dModel,
    atlasWidth = 2048,
    options: { pad?: number; bleed?: number } = {},
) => {
    // Non-power-of-two atlases break VTube Studio/Unity's texture pipeline;
    // the requested width (e.g. 3x2048 = 6144) snaps up to the next POT.
    const nextPow2 = (value: number) => {
        let pot = 1;
        while (pot < value) pot *= 2;
        return pot;
    };
    atlasWidth = nextPow2(atlasWidth);
    const pad = options.pad ?? Math.max(8, Math.round(atlasWidth / 256));
    const bleed = options.bleed ?? pad;
    let cursorX = pad;
    let cursorY = pad;
    let shelfHeight = 0;
    const placements = model.drawables.map((drawable) => {
        if (cursorX + drawable.texture.width + pad > atlasWidth) {
            cursorX = pad;
            cursorY += shelfHeight + pad;
            shelfHeight = 0;
        }
        const placement = {
            x: cursorX,
            y: cursorY,
            width: drawable.texture.width,
            height: drawable.texture.height,
        };
        cursorX += placement.width + pad;
        shelfHeight = Math.max(shelfHeight, placement.height);
        return placement;
    });
    // VTube Studio/Unity's texture pipeline breaks on non-power-of-two
    // atlases (the model renders as a giant blurry mass with a valid moc3),
    // so the atlas height is always rounded up to a power of two. Content
    // stays packed at the top; UVs below normalize against the final POT
    // height, so nothing shifts.
    const atlasHeight = nextPow2(cursorY + shelfHeight + pad);
    const rgba = new Uint8Array(atlasWidth * atlasHeight * 4);
    model.drawables.forEach((drawable, index) => {
        const placement = placements[index];
        for (let row = 0; row < placement.height; row += 1) {
            const sourceStart = row * placement.width * 4;
            const targetStart = ((placement.y + row) * atlasWidth + placement.x) * 4;
            rgba.set(
                drawable.texture.rgba.subarray(sourceStart, sourceStart + placement.width * 4),
                targetStart,
            );
        }
    });

    // Bleed every shelf's border texels outward into the pad gap (BFS from
    // the shelf's opaque texels, `bleed` steps, never crossing into another
    // shelf's rect). Boundary triangles UV past their islands; without this
    // they sample transparent gap texels and fray the silhouette.
    placements.forEach((placement) => {
        const x0 = Math.max(0, placement.x - bleed);
        const y0 = Math.max(0, placement.y - bleed);
        const x1 = Math.min(atlasWidth, placement.x + placement.width + bleed);
        const y1 = Math.min(atlasHeight, placement.y + placement.height + bleed);
        const regionW = x1 - x0;
        const inShelf = (x: number, y: number) =>
            x >= placement.x &&
            x < placement.x + placement.width &&
            y >= placement.y &&
            y < placement.y + placement.height;
        const depthLimit = new Int16Array(regionW * (y1 - y0)).fill(-1);
        const queue: number[] = [];
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
                if (rgba[(y * atlasWidth + x) * 4 + 3] > 0) {
                    const index = (y - y0) * regionW + (x - x0);
                    depthLimit[index] = 0;
                    queue.push(x, y);
                }
            }
        }
        let head = 0;
        while (head < queue.length) {
            const x = queue[head];
            const y = queue[head + 1];
            head += 2;
            const cell = (y - y0) * regionW + (x - x0);
            const nextDepth = depthLimit[cell] + 1;
            if (nextDepth > bleed) {
                continue;
            }
            const neighbors = [x - 1, y, x + 1, y, x, y - 1, x, y + 1];
            for (let n = 0; n < 8; n += 2) {
                const nx = neighbors[n];
                const ny = neighbors[n + 1];
                if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) {
                    continue;
                }
                if (inShelf(nx, ny)) {
                    continue; // never paint over a shelf's own texels
                }
                const target = (ny * atlasWidth + nx) * 4;
                if (rgba[target + 3] > 0) {
                    continue; // already bled (or another shelf's texel)
                }
                const source = (y * atlasWidth + x) * 4;
                rgba[target] = rgba[source];
                rgba[target + 1] = rgba[source + 1];
                rgba[target + 2] = rgba[source + 2];
                rgba[target + 3] = 255;
                const index = (ny - y0) * regionW + (nx - x0);
                depthLimit[index] = nextDepth;
                queue.push(nx, ny);
            }
        }
    });
    const uvs = model.drawables.map((drawable, index) => {
        const placement = placements[index];
        const next = new Float32Array(drawable.vertexCount * 2);
        for (let v = 0; v < drawable.vertexCount; v += 1) {
            const u = drawable.uvs[v * 2] * placement.width + placement.x;
            const vv = drawable.uvs[v * 2 + 1] * placement.height + placement.y;
            next[v * 2] = u / atlasWidth;
            next[v * 2 + 1] = vv / atlasHeight;
        }
        return next;
    });
    return { atlas: { width: atlasWidth, height: atlasHeight, rgba }, uvs };
};

export type PngEncoder = (texture: { width: number; height: number; rgba: Uint8Array }) => Uint8Array;

/** Builds a Cubism-importable zip: model.moc3 + atlas texture + model3.json. */
export const buildMoc3Archive = (
    model: Live2dModel,
    encodePng: PngEncoder,
    options: { angleKeys?: number[]; maxMorphKeys?: number; atlasWidth?: number } = {},
): Uint8Array => {
    const atlasWidth =
        options.atlasWidth ?? Math.min(8192, 2048 * (model.textureScale ?? 1));
    const packed = packTextureAtlas(model, atlasWidth);
    const modelWithAtlasUvs: Live2dModel = {
        ...model,
        drawables: model.drawables.map((drawable, index) => ({
            ...drawable,
            uvs: packed.uvs[index],
        })),
    };
    const { moc3 } = buildMoc3(modelWithAtlasUvs, options);

    // VTube Studio scans Live2DModels/<folder>/<name>.model3.json and skips
    // non-ASCII filenames, so the archive carries a self-contained folder
    // with an ASCII-safe name; extracting straight into Live2DModels works.
    const safeName =
        model.modelName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) ||
        'model';

    const manifest = {
        Version: 3,
        Name: model.modelName,
        FileReferences: {
            Moc: 'model.moc3',
            Textures: ['texture_00.png'],
        },
        Groups: [],
        HitAreas: [],
    };
    const entries: ZipEntry[] = [
        { name: `${safeName}/model.moc3`, data: moc3 },
        { name: `${safeName}/texture_00.png`, data: encodePng(packed.atlas) },
        {
            name: `${safeName}/${safeName}.model3.json`,
            data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        },
    ];
    return createZip(entries);
};
