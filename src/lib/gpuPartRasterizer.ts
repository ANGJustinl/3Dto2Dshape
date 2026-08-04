import type { ProjectionPartSource } from './modelParts';
import type { MeshProjectionCache } from './partProjection';
import { recordPerfSample } from './perfLogger';
import { getSharedWebGpuContext } from './webgpuShared';

type GPUBufferLike = any;
type GPUComputePipelineLike = any;
type GPUDeviceLike = any;
type GPUBindGroupLike = any;
type GPUTextureLike = any;

export type GpuRasterizedPartData = {
    occupied: Uint8Array;
    depthValues: Float32Array;
    nearestDepth: number;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    atlasX: number;
    atlasY: number;
    atlasWidth: number;
    atlasHeight: number;
};

type PartBounds = {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
};

type RasterizeRequest = {
    part: ProjectionPartSource;
    projectionCache: MeshProjectionCache;
    fallbackDepth: number;
};

type PreparedRequest = RasterizeRequest & {
    bounds: PartBounds;
    atlasX: number;
    atlasY: number;
    nearestDepth: number;
    triangleData: Float32Array;
};

const WORKGROUP_SIZE = 8;
const ATLAS_PADDING = 1;
const MASK_FORMAT = 'rgba8unorm';
const DEPTH_FORMAT = 'r32float';

const GPUBufferUsageStorage = 0x0080;
const GPUBufferUsageUniform = 0x0040;
const GPUBufferUsageCopyDst = 0x0008;
const GPUBufferUsageMapRead = 0x0001;
const GPUTextureUsageStorageBinding = 0x0008;
const GPUTextureUsageTextureBinding = 0x0004;
const GPUTextureUsageCopySrc = 0x0001;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const computePartBounds = (
    part: ProjectionPartSource,
    projectionCache: MeshProjectionCache,
) => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    part.triangles.forEach((triangle) => {
        triangle.vertexIndices.forEach((vertexIndex) => {
            const x = projectionCache.screenX[vertexIndex];
            const y = projectionCache.screenY[vertexIndex];
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        });
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }

    const offsetX = Math.max(0, Math.floor(minX) - 2);
    const offsetY = Math.max(0, Math.floor(minY) - 2);
    const maxBoundX = Math.min(projectionCache.width, Math.ceil(maxX) + 2);
    const maxBoundY = Math.min(projectionCache.height, Math.ceil(maxY) + 2);
    const width = maxBoundX - offsetX;
    const height = maxBoundY - offsetY;
    if (width <= 1 || height <= 1) {
        return null;
    }

    return {
        width,
        height,
        offsetX,
        offsetY,
    } satisfies PartBounds;
};

class GpuPartRasterizer {
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private pipeline: GPUComputePipelineLike | null = null;
    private bindGroupLayout: any = null;
    private maskTexture: GPUTextureLike | null = null;
    private depthTexture: GPUTextureLike | null = null;
    private atlasWidth = 1;
    private atlasHeight = 1;

    async rasterizeBatch(requests: RasterizeRequest[]) {
        const totalStart = performance.now();
        const device = await this.getDevice();
        if (!device) {
            return [] as Array<GpuRasterizedPartData | null>;
        }

        this.ensurePipeline(device);
        const prepareStart = performance.now();
        const preparedRequests = this.prepareRequests(requests);
        const prepareMs = performance.now() - prepareStart;
        if (preparedRequests.length === 0) {
            return [] as Array<GpuRasterizedPartData | null>;
        }

        const atlasWidth = preparedRequests.reduce(
            (currentMax, request) => Math.max(currentMax, request.atlasX + request.bounds.width),
            1,
        );
        const atlasHeight = preparedRequests.reduce(
            (currentMax, request) => Math.max(currentMax, request.atlasY + request.bounds.height),
            1,
        );
        this.ensureAtlasTextures(device, atlasWidth, atlasHeight);

        const encodeStart = performance.now();
        const commandEncoder = device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.pipeline);

        preparedRequests.forEach((request) => {
            const triangleBuffer = this.createBuffer(device, request.triangleData, GPUBufferUsageStorage | GPUBufferUsageCopyDst);
            const uniformBuffer = this.createBuffer(
                device,
                new Float32Array([
                    request.bounds.offsetX,
                    request.bounds.offsetY,
                    request.bounds.width,
                    request.bounds.height,
                    request.atlasX,
                    request.atlasY,
                    atlasWidth,
                    atlasHeight,
                    request.triangleData.length / 12,
                    request.fallbackDepth,
                    0,
                    0,
                ]),
                GPUBufferUsageUniform | GPUBufferUsageCopyDst,
            );
            const bindGroup = device.createBindGroup({
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: triangleBuffer } },
                    { binding: 1, resource: { buffer: uniformBuffer } },
                    { binding: 2, resource: this.maskTexture.createView() },
                    { binding: 3, resource: this.depthTexture.createView() },
                ],
            });

            computePass.setBindGroup(0, bindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(request.bounds.width / WORKGROUP_SIZE),
                Math.ceil(request.bounds.height / WORKGROUP_SIZE),
            );
        });

        computePass.end();

        const maskBytesPerRow = Math.ceil((atlasWidth * 4) / 256) * 256;
        const maskReadbackBuffer = device.createBuffer({
            size: maskBytesPerRow * atlasHeight,
            usage: GPUBufferUsageMapRead | GPUBufferUsageCopyDst,
        });
        const depthBytesPerRow = Math.ceil((atlasWidth * Float32Array.BYTES_PER_ELEMENT) / 256) * 256;
        const depthReadbackBuffer = device.createBuffer({
            size: depthBytesPerRow * atlasHeight,
            usage: GPUBufferUsageMapRead | GPUBufferUsageCopyDst,
        });
        commandEncoder.copyTextureToBuffer(
            { texture: this.maskTexture },
            { buffer: maskReadbackBuffer, bytesPerRow: maskBytesPerRow, rowsPerImage: atlasHeight },
            { width: atlasWidth, height: atlasHeight, depthOrArrayLayers: 1 },
        );
        commandEncoder.copyTextureToBuffer(
            { texture: this.depthTexture },
            { buffer: depthReadbackBuffer, bytesPerRow: depthBytesPerRow, rowsPerImage: atlasHeight },
            { width: atlasWidth, height: atlasHeight, depthOrArrayLayers: 1 },
        );
        const encodeMs = performance.now() - encodeStart;

        const submitReadbackStart = performance.now();
        device.queue.submit([commandEncoder.finish()]);
        await Promise.all([maskReadbackBuffer.mapAsync(1), depthReadbackBuffer.mapAsync(1)]);
        const maskPixels = new Uint8Array(maskReadbackBuffer.getMappedRange().slice(0));
        const depthPixels = new Float32Array(depthReadbackBuffer.getMappedRange().slice(0));
        maskReadbackBuffer.unmap();
        depthReadbackBuffer.unmap();
        maskReadbackBuffer.destroy();
        depthReadbackBuffer.destroy();
        const submitReadbackMs = performance.now() - submitReadbackStart;

        const extractStart = performance.now();
        const results = preparedRequests.map((request) =>
            this.extractRasterizedData(
                maskPixels,
                maskBytesPerRow,
                depthPixels,
                depthBytesPerRow / Float32Array.BYTES_PER_ELEMENT,
                request,
                atlasWidth,
                atlasHeight,
            ),
        );
        const extractMs = performance.now() - extractStart;

        recordPerfSample({
            label: 'gpu-rasterizer',
            values: {
                prepareRequests: prepareMs,
                encode: encodeMs,
                submitReadback: submitReadbackMs,
                extractResults: extractMs,
                total: performance.now() - totalStart,
            },
        });

        return results;
    }

    private async getDevice() {
        if (!this.devicePromise) {
            this.devicePromise = getSharedWebGpuContext().getDevice();
        }
        return this.devicePromise;
    }

    private ensurePipeline(device: GPUDeviceLike) {
        if (this.pipeline) {
            return;
        }

        this.pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: device.createShaderModule({
                    code: `
struct Uniforms {
    offsetX: f32,
    offsetY: f32,
    width: f32,
    height: f32,
    atlasX: f32,
    atlasY: f32,
    atlasWidth: f32,
    atlasHeight: f32,
    triangleCount: f32,
    fallbackDepth: f32,
    padding0: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> triangles: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;
@group(0) @binding(2) var maskAtlas: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var depthAtlas: texture_storage_2d<r32float, write>;

fn triangleSignedArea(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> f32 {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

fn isPointInTriangle(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> bool {
    let area0 = triangleSignedArea(point, a, b);
    let area1 = triangleSignedArea(point, b, c);
    let area2 = triangleSignedArea(point, c, a);
    let hasNegative = area0 < 0.0 || area1 < 0.0 || area2 < 0.0;
    let hasPositive = area0 > 0.0 || area1 > 0.0 || area2 > 0.0;
    return !(hasNegative && hasPositive);
}

fn interpolateDepth(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, da: f32, db: f32, dc: f32) -> f32 {
    let area = triangleSignedArea(a, b, c);
    if (abs(area) < 0.00001) {
        return min(da, min(db, dc));
    }
    let w0 = triangleSignedArea(point, b, c) / area;
    let w1 = triangleSignedArea(point, c, a) / area;
    let w2 = triangleSignedArea(point, a, b) / area;
    return da * w0 + db * w1 + dc * w2;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    if (f32(globalId.x) >= uniforms.width || f32(globalId.y) >= uniforms.height) {
        return;
    }

    let samplePoint = vec2<f32>(
        uniforms.offsetX + f32(globalId.x) + 0.5,
        uniforms.offsetY + f32(globalId.y) + 0.5
    );
    var occupied = false;
    var bestDepth = 1e20;

    for (var triangleIndex = 0u; triangleIndex < u32(uniforms.triangleCount); triangleIndex += 1u) {
        let base = triangleIndex * 3u;
        let t0 = triangles[base];
        let t1 = triangles[base + 1u];
        let t2 = triangles[base + 2u];
        let p0 = t0.xy;
        let p1 = t1.xy;
        let p2 = t2.xy;
        if (!isPointInTriangle(samplePoint, p0, p1, p2)) {
            continue;
        }

        let depth = interpolateDepth(samplePoint, p0, p1, p2, t0.z, t1.z, t2.z);
        if (depth < bestDepth) {
            bestDepth = depth;
        }
        occupied = true;
    }

    let atlasCoord = vec2<i32>(i32(uniforms.atlasX) + i32(globalId.x), i32(uniforms.atlasY) + i32(globalId.y));
    if (occupied) {
        textureStore(maskAtlas, atlasCoord, vec4<f32>(1.0, 1.0, 1.0, 1.0));
        textureStore(depthAtlas, atlasCoord, vec4<f32>(bestDepth, 0.0, 0.0, 0.0));
    } else {
        textureStore(maskAtlas, atlasCoord, vec4<f32>(0.0));
        textureStore(depthAtlas, atlasCoord, vec4<f32>(1e20, 0.0, 0.0, 0.0));
    }
}
                    `,
                }),
                entryPoint: 'main',
            },
        });
        this.bindGroupLayout = this.pipeline.getBindGroupLayout(0);
    }

    private ensureAtlasTextures(device: GPUDeviceLike, atlasWidth: number, atlasHeight: number) {
        if (
            this.maskTexture &&
            this.depthTexture &&
            this.atlasWidth === atlasWidth &&
            this.atlasHeight === atlasHeight
        ) {
            return;
        }

        this.maskTexture?.destroy();
        this.depthTexture?.destroy();

        this.maskTexture = device.createTexture({
            size: { width: atlasWidth, height: atlasHeight, depthOrArrayLayers: 1 },
            format: MASK_FORMAT,
            usage: GPUTextureUsageStorageBinding | GPUTextureUsageTextureBinding | GPUTextureUsageCopySrc,
        });
        this.depthTexture = device.createTexture({
            size: { width: atlasWidth, height: atlasHeight, depthOrArrayLayers: 1 },
            format: DEPTH_FORMAT,
            usage: GPUTextureUsageStorageBinding | GPUTextureUsageTextureBinding | GPUTextureUsageCopySrc,
        });
        this.atlasWidth = atlasWidth;
        this.atlasHeight = atlasHeight;
    }

    private prepareRequests(requests: RasterizeRequest[]) {
        const atlasMaxWidth = 2048;
        const preparedRequests: PreparedRequest[] = [];
        let cursorX = 0;
        let cursorY = 0;
        let rowHeight = 0;

        requests.forEach((request) => {
            const bounds = computePartBounds(request.part, request.projectionCache);
            if (!bounds) {
                return;
            }

            const triangleData = new Float32Array(request.part.triangles.length * 12);
            let offset = 0;
            request.part.triangles.forEach((triangle) => {
                triangle.vertexIndices.forEach((vertexIndex) => {
                    triangleData[offset] = request.projectionCache.screenX[vertexIndex];
                    triangleData[offset + 1] = request.projectionCache.screenY[vertexIndex];
                    triangleData[offset + 2] = request.projectionCache.depth[vertexIndex];
                    triangleData[offset + 3] = 0;
                    offset += 4;
                });
            });

            if (cursorX > 0 && cursorX + bounds.width > atlasMaxWidth) {
                cursorX = 0;
                cursorY += rowHeight + ATLAS_PADDING;
                rowHeight = 0;
            }

            preparedRequests.push({
                ...request,
                bounds,
                atlasX: cursorX,
                atlasY: cursorY,
                nearestDepth: this.computeNearestDepth(request.part, request.projectionCache, request.fallbackDepth),
                triangleData,
            });

            cursorX += bounds.width + ATLAS_PADDING;
            rowHeight = Math.max(rowHeight, bounds.height);
        });

        return preparedRequests;
    }

    private extractRasterizedData(
        maskPixels: Uint8Array,
        maskBytesPerRow: number,
        depthPixels: Float32Array,
        depthRowStride: number,
        request: PreparedRequest,
        atlasWidth: number,
        atlasHeight: number,
    ) {
        const occupied = new Uint8Array(request.bounds.width * request.bounds.height);
        const depthValues = new Float32Array(request.bounds.width * request.bounds.height);
        depthValues.fill(Number.POSITIVE_INFINITY);

        for (let localY = 0; localY < request.bounds.height; localY += 1) {
            const atlasRow = request.atlasY + localY;
            for (let localX = 0; localX < request.bounds.width; localX += 1) {
                const sourceOffset = atlasRow * maskBytesPerRow + (request.atlasX + localX) * 4;
                const targetIndex = localY * request.bounds.width + localX;
                if (maskPixels[sourceOffset + 3] === 0) {
                    continue;
                }
                occupied[targetIndex] = 1;
                depthValues[targetIndex] = depthPixels[atlasRow * depthRowStride + request.atlasX + localX];
            }
        }

        return {
            occupied,
            depthValues,
            nearestDepth: request.nearestDepth,
            width: request.bounds.width,
            height: request.bounds.height,
            offsetX: request.bounds.offsetX,
            offsetY: request.bounds.offsetY,
            atlasX: request.atlasX,
            atlasY: request.atlasY,
            atlasWidth,
            atlasHeight,
        } satisfies GpuRasterizedPartData;
    }

    private computeNearestDepth(
        part: ProjectionPartSource,
        projectionCache: MeshProjectionCache,
        fallbackDepth: number,
    ) {
        let nearestDepth = Number.POSITIVE_INFINITY;
        part.triangles.forEach((triangle) => {
            triangle.vertexIndices.forEach((vertexIndex) => {
                nearestDepth = Math.min(nearestDepth, projectionCache.depth[vertexIndex]);
            });
        });
        return Number.isFinite(nearestDepth) ? nearestDepth : fallbackDepth;
    }

    private createBuffer(device: GPUDeviceLike, data: Float32Array, usage: number) {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage,
            mappedAtCreation: true,
        });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return buffer;
    }
}

let rasterizer: GpuPartRasterizer | null = null;

export const getGpuPartRasterizer = () => {
    rasterizer ??= new GpuPartRasterizer();
    return rasterizer;
};
