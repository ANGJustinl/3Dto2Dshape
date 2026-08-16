import { computeOrientedBounds2D, type OrientedBounds2D } from '../orientedBounds';
import type { Point2D, WasmRasterSnapshot } from '../2DRenderShared/types';
import type { RasterizedPartData } from '../2DRenderStages/partRasterization/rasterizer';
import type { ProjectionPartSource } from '../modelParts';
import { recordPerfSample } from '../perfLogger';

export type WasmRasterPartInput = {
    part: ProjectionPartSource;
    triangleData: Float32Array;
    fallbackDepth: number;
    orientedBounds?: OrientedBounds2D;
};

type WasmModule = {
    _malloc(size: number): number;
    _free(pointer: number): void;
    _rasterize_contour_batch(
        width: number,
        height: number,
        trianglePointer: number,
        triangleCount: number,
        partOffsetPointer: number,
        partCountPointer: number,
        fallbackDepthPointer: number,
        partCount: number,
        outputPointer: number,
        outputCapacity: number,
    ): number;
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    HEAPU8: Uint8Array;
};

export type WasmRasterBatchResult = {
    parts: Array<RasterizedPartData | null>;
    loopCount: number;
    outputBytes: number;
    timings: {
        inputPack: number;
        wasmCall: number;
        outputCopy: number;
        total: number;
    };
};

const WASM_URL = `${import.meta.env.BASE_URL}wasm/raster_contour.js`;
const INIT_TIMEOUT_MS = 8000;
const OUTPUT_HEADER_BYTES = 24;
const OUTPUT_DESCRIPTOR_BYTES = 48;
const OUTPUT_MAGIC = 0x32525343;

const align4 = (value: number) => (value + 3) & ~3;

type WasmModuleFactory = (options?: {
    locateFile?: (file: string) => string;
}) => Promise<WasmModule>;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
    let timeoutId = 0;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== 0) {
            window.clearTimeout(timeoutId);
        }
    }
};

const toPoints = (triangleData: Float32Array) => {
    const points: Point2D[] = [];
    for (let index = 0; index < triangleData.length; index += 12) {
        points.push(
            { x: triangleData[index], y: triangleData[index + 1] },
            { x: triangleData[index + 4], y: triangleData[index + 5] },
            { x: triangleData[index + 8], y: triangleData[index + 9] },
        );
    }
    return points;
};

class RasterContourClient {
    private modulePromise: Promise<WasmModule | null> | null = null;
    private snapshot: WasmRasterSnapshot = { status: 'idle', initMs: 0, lastError: null };
    private listeners = new Set<(snapshot: WasmRasterSnapshot) => void>();

    getSnapshot() {
        return this.snapshot;
    }

    subscribe(listener: (snapshot: WasmRasterSnapshot) => void) {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private setSnapshot(snapshot: WasmRasterSnapshot) {
        this.snapshot = snapshot;
        this.listeners.forEach((listener) => listener(snapshot));
    }

    async initialize(force = false) {
        if (this.modulePromise && !force) {
            return this.modulePromise;
        }
        const start = performance.now();
        this.setSnapshot({ status: 'loading', initMs: 0, lastError: null });
        this.modulePromise = (async () => {
            try {
                const moduleUrl = `${WASM_URL}?v=1`;
                const module = await withTimeout(
                    (async () => {
                        // Files under /public are static assets, so importing their URL
                        // directly makes Vite try to transform them as source. Fetch the
                        // ESM wrapper and import it from a blob URL instead.
                        const response = await fetch(moduleUrl, { cache: 'no-store' });
                        if (!response.ok) {
                            throw new Error(`WASM wrapper request failed with ${response.status}.`);
                        }
                        const source = await response.text();
                        const blobUrl = URL.createObjectURL(
                            new Blob([source], { type: 'text/javascript' }),
                        );
                        try {
                            const imported = await import(/* @vite-ignore */ blobUrl);
                            const factory = (imported as { default?: WasmModuleFactory }).default;
                            if (!factory) {
                                throw new Error('WASM module factory was not exported.');
                            }
                            return factory({
                                locateFile: (file: string) => `${import.meta.env.BASE_URL}wasm/${file}`,
                            });
                        } finally {
                            URL.revokeObjectURL(blobUrl);
                        }
                    })(),
                    INIT_TIMEOUT_MS,
                    'WASM initialization timed out after 8 seconds.',
                );
                this.setSnapshot({ status: 'ready', initMs: performance.now() - start, lastError: null });
                return module;
            } catch (error) {
                const rawMessage = error instanceof Error ? error.message : String(error);
                const message = /failed to fetch dynamically imported module|module script|404|not found/i.test(rawMessage)
                    ? 'WASM artifact is missing. Install emsdk and run tools/wasm/build.ps1.'
                    : rawMessage;
                this.setSnapshot({
                    status: message.includes('timed out') ? 'timed-out' : 'failed',
                    initMs: performance.now() - start,
                    lastError: message,
                });
                return null;
            }
        })();
        return this.modulePromise;
    }

    async runBatch(width: number, height: number, inputs: WasmRasterPartInput[]): Promise<WasmRasterBatchResult | null> {
        const module = await this.initialize();
        if (!module || inputs.length === 0) {
            return null;
        }
        const totalStart = performance.now();
        this.setSnapshot({ ...this.snapshot, status: 'running' });
        const inputPackStart = performance.now();
        const triangles = new Float32Array(inputs.reduce((total, input) => total + (input.triangleData.length / 12) * 9, 0));
        const partOffsets = new Int32Array(inputs.length);
        const partCounts = new Int32Array(inputs.length);
        const fallbackDepth = new Float32Array(inputs.length);
        let triangleOffset = 0;
        inputs.forEach((input, index) => {
            const sourceStride = 12;
            const targetStride = 9;
            const triangleCountForInput = input.triangleData.length / sourceStride;
            for (let triangleIndex = 0; triangleIndex < triangleCountForInput; triangleIndex += 1) {
                const sourceBase = triangleIndex * sourceStride;
                const targetBase = (triangleOffset + triangleIndex) * targetStride;
                for (let vertex = 0; vertex < 3; vertex += 1) {
                    triangles[targetBase + vertex * 3] = input.triangleData[sourceBase + vertex * 4];
                    triangles[targetBase + vertex * 3 + 1] = input.triangleData[sourceBase + vertex * 4 + 1];
                    triangles[targetBase + vertex * 3 + 2] = input.triangleData[sourceBase + vertex * 4 + 2];
                }
            }
            partOffsets[index] = triangleOffset;
            partCounts[index] = triangleCountForInput;
            fallbackDepth[index] = input.fallbackDepth;
            triangleOffset += partCounts[index];
        });
        const trianglePointer = module._malloc(triangles.byteLength);
        const partOffsetPointer = module._malloc(partOffsets.byteLength);
        const partCountPointer = module._malloc(partCounts.byteLength);
        const fallbackDepthPointer = module._malloc(fallbackDepth.byteLength);
        module.HEAPF32.set(triangles, trianglePointer / 4);
        module.HEAP32.set(partOffsets, partOffsetPointer / 4);
        module.HEAP32.set(partCounts, partCountPointer / 4);
        module.HEAPF32.set(fallbackDepth, fallbackDepthPointer / 4);
        const inputPack = performance.now() - inputPackStart;

        let outputPointer = 0;
        try {
            const query = module._rasterize_contour_batch(
                width, height, trianglePointer, triangleOffset,
                partOffsetPointer, partCountPointer, fallbackDepthPointer,
                inputs.length, 0, 0,
            );
            if (query <= 0) {
                throw new Error(`WASM rasterizer returned ${query} while querying output size.`);
            }
            outputPointer = module._malloc(query);
            const wasmCallStart = performance.now();
            const written = module._rasterize_contour_batch(
                width, height, trianglePointer, triangleOffset,
                partOffsetPointer, partCountPointer, fallbackDepthPointer,
                inputs.length, outputPointer, query,
            );
            const wasmCall = performance.now() - wasmCallStart;
            if (written <= 0 || written > query) {
                throw new Error(`WASM rasterizer returned invalid output size ${written}.`);
            }
            const outputCopyStart = performance.now();
            const bytes = module.HEAPU8.slice(outputPointer, outputPointer + written);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (view.getUint32(0, true) !== OUTPUT_MAGIC) {
                throw new Error('WASM rasterizer output magic mismatch.');
            }
            const partCount = view.getUint32(8, true);
            const maskBytes = view.getUint32(12, true);
            const depthValues = view.getUint32(16, true);
            const loopCount = view.getUint32(20, true);
            const descriptorsOffset = OUTPUT_HEADER_BYTES;
            const maskOffset = descriptorsOffset + partCount * OUTPUT_DESCRIPTOR_BYTES;
            const depthOffset = align4(maskOffset + maskBytes);
            const loopOffset = depthOffset + depthValues * 4;
            const pointOffset = loopOffset + loopCount * 4;
            const parts = inputs.map((input, index) => {
                const descriptor = descriptorsOffset + index * OUTPUT_DESCRIPTOR_BYTES;
                const status = view.getUint32(descriptor, true);
                const offsetX = view.getInt32(descriptor + 4, true);
                const offsetY = view.getInt32(descriptor + 8, true);
                const partWidth = view.getUint32(descriptor + 12, true);
                const partHeight = view.getUint32(descriptor + 16, true);
                const localMaskOffset = view.getUint32(descriptor + 20, true);
                const localDepthOffset = view.getUint32(descriptor + 24, true);
                const localLoopOffset = view.getUint32(descriptor + 28, true);
                const localLoopCount = view.getUint32(descriptor + 32, true);
                const nearestDepth = view.getFloat32(descriptor + 36, true);
                const localPointOffset = view.getUint32(descriptor + 40, true);
                if (status === 0 || partWidth === 0 || partHeight === 0) {
                    return null;
                }
                const occupied = bytes.slice(maskOffset + localMaskOffset, maskOffset + localMaskOffset + partWidth * partHeight);
                const depthBytes = bytes.slice(
                    depthOffset + localDepthOffset * 4,
                    depthOffset + (localDepthOffset + partWidth * partHeight) * 4,
                );
                const depth = new Float32Array(
                    depthBytes.buffer,
                    depthBytes.byteOffset,
                    partWidth * partHeight,
                );
                const loops: Array<Array<Point2D>> = [];
                let pointCursor = 0;
                for (let loopIndex = 0; loopIndex < localLoopCount; loopIndex += 1) {
                    const pointCount = view.getUint32(loopOffset + (localLoopOffset + loopIndex) * 4, true);
                    const loop: Point2D[] = [];
                    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
                        const pointBase = pointOffset + (localPointOffset + pointCursor) * 8;
                        loop.push({ x: view.getFloat32(pointBase, true), y: view.getFloat32(pointBase + 4, true) });
                        pointCursor += 1;
                    }
                    loops.push(loop);
                }
                const orientedBounds = input.orientedBounds ?? computeOrientedBounds2D(toPoints(input.triangleData));
                if (!orientedBounds) {
                    return null;
                }
                return {
                    occupied,
                    depth,
                    loops,
                    nearestDepth,
                    width: partWidth,
                    height: partHeight,
                    offsetX,
                    offsetY,
                    atlasX: 0,
                    atlasY: 0,
                    atlasWidth: 0,
                    atlasHeight: 0,
                    orientedBounds,
                } satisfies RasterizedPartData;
            });
            const outputCopy = performance.now() - outputCopyStart;
            this.setSnapshot({
                ...this.snapshot,
                status: 'ready',
                lastBatch: {
                    totalMs: performance.now() - totalStart,
                    wasmCallMs: wasmCall,
                    outputCopyMs: outputCopy,
                    partCount: inputs.length,
                    triangleCount: triangleOffset,
                    loopCount,
                    outputBytes: written,
                },
            });
            recordPerfSample({
                label: 'wasm-raster-contour',
                values: {
                    inputPack,
                    wasmCall,
                    wasmRasterize: wasmCall,
                    wasmDepthVisibility: 0,
                    wasmContour: 0,
                    outputCopy,
                    atlasPack: 0,
                    atlasUpload: 0,
                    total: performance.now() - totalStart,
                    backend: 1,
                    partCount: inputs.length,
                    triangleCount: triangleOffset,
                    loopCount,
                    outputBytes: written,
                },
            });
            return {
                parts,
                loopCount,
                outputBytes: written,
                timings: { inputPack, wasmCall, outputCopy, total: performance.now() - totalStart },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setSnapshot({ ...this.snapshot, status: 'failed', lastError: message });
            return null;
        } finally {
            module._free(trianglePointer);
            module._free(partOffsetPointer);
            module._free(partCountPointer);
            module._free(fallbackDepthPointer);
            if (outputPointer !== 0) {
                module._free(outputPointer);
            }
        }
    }
}

let client: RasterContourClient | null = null;

export const getRasterContourClient = () => {
    client ??= new RasterContourClient();
    return client;
};
