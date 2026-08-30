import type { FamilyKeyforms } from './keyforms';
import type { Live2dModel } from './model';
import { createZip, parseZip, type ZipEntry } from './zip';

/**
 * M5: custom Live2D format serialization.
 *
 * Layout inside the zip:
 *   model.json                — manifest: params, order, drawable metadata,
 *                               family keyform value tables, binary offsets
 *   drawables/<id>.bin        — Float32 LE: neutral xy, uv, then Uint32
 *                               triangles + mesh vertex indices
 *   textures/<id>.png         — cropped isolated texture (codec injectable)
 *   families/<family>.bin     — Float32 LE concatenated per-keyform blocks
 *
 * PNG encode/decode is injected so vitest can round-trip with a byte stub
 * while the browser uses canvas.toDataURL / createImageBitmap.
 */

type ModelFileManifest = {
    schemaVersion: 1;
    createdAt: string;
    modelName: string;
    viewport: { width: number; height: number };
    params: Live2dModel['params'];
    order: string[];
    drawables: Array<{
        id: string;
        label: string;
        meshId: string;
        leafIds: string[];
        vertexCount: number;
        triangleCount: number;
        textureFile: string;
        textureWidth: number;
        textureHeight: number;
        binFile: string;
    }>;
    families: Array<{
        family: string;
        default: number;
        values: number[];
        file: string;
    }>;
    neutralDepths: number[];
    depths: Array<{
        family: string;
        default: number;
        values: number[];
        file: string;
    }>;
};

export type PngCodec = {
    encode: (texture: { width: number; height: number; rgba: Uint8Array }) => Uint8Array;
    decode: (bytes: Uint8Array) => Promise<{ width: number; height: number; rgba: Uint8Array }>;
};

export const defaultPngCodec: PngCodec = {
    encode: (texture) => {
        const canvas = document.createElement('canvas');
        canvas.width = texture.width;
        canvas.height = texture.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context unavailable for PNG encoding.');
        }
        context.putImageData(
            new ImageData(new Uint8ClampedArray(texture.rgba), texture.width, texture.height),
            0,
            0,
        );
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    },
    decode: async (bytes) => {
        // bytes may be a subarray view into the zip buffer; pass the view
        // itself so the Blob contains exactly the PNG bytes.
        const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }));
        // Capture dims before close(): a closed ImageBitmap reports 0x0.
        const width = bitmap.width;
        const height = bitmap.height;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context unavailable for PNG decoding.');
        }
        context.drawImage(bitmap, 0, 0);
        const imageData = context.getImageData(0, 0, width, height);
        bitmap.close();
        return { width, height, rgba: new Uint8Array(imageData.data) };
    },
};

export const exportModel = (
    model: Live2dModel,
    codec: PngCodec = defaultPngCodec,
): Uint8Array => {
    const entries: ZipEntry[] = [];
    const manifest: ModelFileManifest = {
        schemaVersion: 1,
        createdAt: model.createdAt,
        modelName: model.modelName,
        viewport: model.viewport,
        params: model.params,
        order: model.order,
        drawables: [],
        families: [],
        neutralDepths: model.neutralDepths,
        depths: [],
    };

    model.drawables.forEach((drawable) => {
        const binFile = `drawables/${drawable.id}.bin`;
        const textureFile = `textures/${drawable.id}.png`;
        const floats = drawable.vertexCount * 4;
        const bin = new Uint8Array(floats * 4 + drawable.triangles.byteLength + drawable.meshVertexIndices.byteLength);
        const floatView = new Float32Array(bin.buffer, 0, floats);
        for (let v = 0; v < drawable.vertexCount; v += 1) {
            floatView[v * 4] = drawable.neutralPositions[v * 2];
            floatView[v * 4 + 1] = drawable.neutralPositions[v * 2 + 1];
            floatView[v * 4 + 2] = drawable.uvs[v * 2];
            floatView[v * 4 + 3] = drawable.uvs[v * 2 + 1];
        }
        const uintView = new Uint32Array(bin.buffer);
        uintView.set(drawable.triangles, floats);
        uintView.set(drawable.meshVertexIndices, floats + drawable.triangles.length);

        entries.push({ name: binFile, data: bin });
        entries.push({ name: textureFile, data: codec.encode(drawable.texture) });
        manifest.drawables.push({
            id: drawable.id,
            label: drawable.label,
            meshId: drawable.meshId,
            leafIds: drawable.leafIds,
            vertexCount: drawable.vertexCount,
            triangleCount: drawable.triangleCount,
            textureFile,
            textureWidth: drawable.texture.width,
            textureHeight: drawable.texture.height,
            binFile,
        });
    });

    Object.entries(model.families).forEach(([family, keyforms]) => {
        const file = `families/${family}.bin`;
        const totalFloats = keyforms.displacements.reduce((total, block) => total + block.length, 0);
        const combined = new Float32Array(totalFloats);
        let cursor = 0;
        keyforms.displacements.forEach((block) => {
            combined.set(block, cursor);
            cursor += block.length;
        });
        entries.push({ name: file, data: new Uint8Array(combined.buffer) });
        manifest.families.push({ family, default: keyforms.default, values: keyforms.values, file });
    });

    Object.entries(model.depthFamilies ?? {}).forEach(([family, keyforms]) => {
        const file = `depths/${family}.bin`;
        const perKeyform = keyforms.displacements[0]?.length ?? 0;
        const combined = new Float32Array(keyforms.displacements.length * perKeyform);
        let cursor = 0;
        keyforms.displacements.forEach((block) => {
            combined.set(block, cursor);
            cursor += block.length;
        });
        entries.push({ name: file, data: new Uint8Array(combined.buffer) });
        manifest.depths.push({ family, default: keyforms.default, values: keyforms.values, file });
    });

    entries.push({
        name: 'model.json',
        data: new TextEncoder().encode(JSON.stringify(manifest)),
    });
    return createZip(entries);
};

const bytesEqual = (left: ArrayLike<number>, right: ArrayLike<number>) => {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
};

/**
 * Canvas PNG round-trips perturb semi-transparent edge pixels (premultiplied
 * rounding), so textures compare with a small per-channel tolerance instead
 * of raw byte equality.
 */
const CHANNEL_TOLERANCE = 3;

const texturesCompatible = (left: Uint8Array, right: Uint8Array) => {
    if (left.length !== right.length) {
        return { compatible: false, differingPixels: Number.POSITIVE_INFINITY, maxDelta: 255 };
    }
    let differingPixels = 0;
    let maxDelta = 0;
    for (let pixel = 0; pixel < left.length; pixel += 4) {
        let pixelDelta = 0;
        for (let channel = 0; channel < 4; channel += 1) {
            const delta = Math.abs(left[pixel + channel] - right[pixel + channel]);
            pixelDelta = Math.max(pixelDelta, delta);
        }
        maxDelta = Math.max(maxDelta, pixelDelta);
        if (pixelDelta > CHANNEL_TOLERANCE) {
            differingPixels += 1;
        }
    }
    return { compatible: differingPixels === 0, differingPixels, maxDelta };
};

/** Byte-level round-trip check: exported zip re-imports into identical buffers. */
export const verifyRoundtripBytes = (original: Live2dModel, reimported: Live2dModel): string[] => {
    const problems: string[] = [];
    if (original.drawables.length !== reimported.drawables.length) {
        problems.push(`drawable count ${original.drawables.length} != ${reimported.drawables.length}`);
        return problems;
    }
    original.drawables.forEach((drawable, index) => {
        const other = reimported.drawables[index];
        if (drawable.id !== other.id) {
            problems.push(`drawable[${index}] id ${drawable.id} != ${other.id}`);
        }
        if (!bytesEqual(drawable.neutralPositions, other.neutralPositions)) {
            problems.push(`${drawable.id}: neutral positions differ`);
        }
        if (!bytesEqual(drawable.uvs, other.uvs)) {
            problems.push(`${drawable.id}: uvs differ`);
        }
        if (!bytesEqual(drawable.triangles, other.triangles)) {
            problems.push(`${drawable.id}: triangles differ`);
        }
        if (drawable.texture.width !== other.texture.width || drawable.texture.height !== other.texture.height) {
            problems.push(
                `${drawable.id}: texture dims ${drawable.texture.width}x${drawable.texture.height} vs ${other.texture.width}x${other.texture.height}`,
            );
        }
        const textureComparison = texturesCompatible(drawable.texture.rgba, other.texture.rgba);
        if (!textureComparison.compatible) {
            problems.push(
                `${drawable.id}: texture differs beyond tolerance (${textureComparison.differingPixels} px)`,
            );
        }
        if (drawable.renderOrder !== other.renderOrder) {
            problems.push(`${drawable.id}: render order differs`);
        }
    });
    Object.entries(original.families).forEach(([family, keyforms]) => {
        const other = reimported.families[family];
        if (!other) {
            problems.push(`family ${family} missing after import`);
            return;
        }
        if (keyforms.values.join() !== other.values.join()) {
            problems.push(`family ${family}: keyform values differ`);
        }
        if (keyforms.displacements.length !== other.displacements.length) {
            problems.push(`family ${family}: keyform count differs`);
            return;
        }
        keyforms.displacements.forEach((displacement, keyformIndex) => {
            if (!bytesEqual(displacement, other.displacements[keyformIndex])) {
                problems.push(`family ${family} keyform ${keyformIndex}: bytes differ`);
            }
        });
    });
    Object.entries(original.depthFamilies ?? {}).forEach(([family, keyforms]) => {
        const other = reimported.depthFamilies?.[family];
        if (!other) {
            problems.push(`depth family ${family} missing after import`);
            return;
        }
        if (keyforms.values.join() !== other.values.join()) {
            problems.push(`depth family ${family}: keyform values differ`);
            return;
        }
        keyforms.displacements.forEach((displacement, keyformIndex) => {
            if (!bytesEqual(displacement, other.displacements[keyformIndex])) {
                problems.push(`depth family ${family} keyform ${keyformIndex}: bytes differ`);
            }
        });
    });
    if ((original.neutralDepths ?? []).join() !== (reimported.neutralDepths ?? []).join()) {
        problems.push('neutral depths differ');
    }
    return problems;
};

export const importModel = async (
    zipBytes: Uint8Array,
    codec: PngCodec = defaultPngCodec,
): Promise<Live2dModel> => {
    const files = parseZip(zipBytes);
    const manifestBytes = files.get('model.json');
    if (!manifestBytes) {
        throw new Error('model.json missing from Live2D model archive.');
    }
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ModelFileManifest;

    const drawables = await Promise.all(
        manifest.drawables.map(async (entry) => {
            // .slice() realigns the subarray to a 0 byteOffset so Float32Array
            // views over the zip buffer stay 4-byte aligned.
            const bin = files.get(entry.binFile)?.slice();
            const textureBytes = files.get(entry.textureFile);
            if (!bin || !textureBytes) {
                throw new Error(`Missing binary payload for drawable ${entry.id}.`);
            }
            const floats = entry.vertexCount * 4;
            const floatView = new Float32Array(bin.buffer, bin.byteOffset, floats);
            const neutralPositions = new Float32Array(entry.vertexCount * 2);
            const uvs = new Float32Array(entry.vertexCount * 2);
            for (let v = 0; v < entry.vertexCount; v += 1) {
                neutralPositions[v * 2] = floatView[v * 4];
                neutralPositions[v * 2 + 1] = floatView[v * 4 + 1];
                uvs[v * 2] = floatView[v * 4 + 2];
                uvs[v * 2 + 1] = floatView[v * 4 + 3];
            }
            const uintView = new Uint32Array(
                bin.buffer,
                bin.byteOffset + floats * 4,
                (bin.byteLength - floats * 4) / 4,
            );
            const triangles = uintView.slice(0, entry.triangleCount * 3);
            const meshVertexIndices = uintView.slice(entry.triangleCount * 3, entry.triangleCount * 3 + entry.vertexCount);

            const decoded = await codec.decode(textureBytes);
            return {
                id: entry.id,
                label: entry.label,
                meshId: entry.meshId,
                leafIds: entry.leafIds,
                vertexCount: entry.vertexCount,
                triangleCount: entry.triangleCount,
                triangles,
                meshVertexIndices,
                neutralPositions,
                uvs,
                texture: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
                renderOrder: 0,
            };
        }),
    );

    const orderIndexById = new Map(manifest.order.map((id, index) => [id, index]));
    drawables.forEach((drawable) => {
        drawable.renderOrder = orderIndexById.get(drawable.id) ?? 0;
    });

    const families: Live2dModel['families'] = {};
    manifest.families.forEach((familyEntry) => {
        const bin = files.get(familyEntry.file)?.slice();
        if (!bin) {
            throw new Error(`Missing keyform payload for family ${familyEntry.family}.`);
        }
        const totalFloats = bin.byteLength / 4;
        const perKeyform = totalFloats / familyEntry.values.length;
        const displacements = familyEntry.values.map((_, keyformIndex) =>
            new Float32Array(
                bin.buffer,
                keyformIndex * perKeyform * 4,
                perKeyform,
            ).slice(),
        );
        families[familyEntry.family] = {
            family: familyEntry.family as FamilyKeyforms['family'],
            default: familyEntry.default,
            values: familyEntry.values,
            displacements,
        };
    });

    const depthFamilies: Live2dModel['depthFamilies'] = {};
    const drawableCount = drawables.length;
    (manifest.depths ?? []).forEach((depthEntry) => {
        const bin = files.get(depthEntry.file)?.slice();
        if (!bin) {
            return; // optional section
        }
        const perKeyform = bin.byteLength / 4 / depthEntry.values.length;
        depthFamilies[depthEntry.family] = {
            family: depthEntry.family as FamilyKeyforms['family'],
            default: depthEntry.default,
            values: depthEntry.values,
            displacements: depthEntry.values.map((_, keyformIndex) =>
                new Float32Array(
                    bin.buffer,
                    keyformIndex * perKeyform * 4,
                    Math.min(perKeyform, drawableCount),
                ).slice(),
            ),
        };
    });

    return {
        schemaVersion: 1,
        createdAt: manifest.createdAt,
        modelName: manifest.modelName,
        viewport: manifest.viewport,
        params: manifest.params,
        drawables,
        families,
        depthFamilies,
        neutralDepths: manifest.neutralDepths ?? drawables.map(() => 0),
        order: manifest.order,
        errorReport: { comboCount: 0, meanErrorPx: 0, maxErrorPx: 0, perCombo: [], worstDrawable: null },
        orderReport: { flips: [], samplesChecked: 0 },
    };
};
