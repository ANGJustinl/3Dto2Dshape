import type { GpuDepthAtlasState } from '../partRasterization/rasterizer';
import type { ProjectedPartShape, ProjectionOverlaySettings } from '../../2DRenderShared/types';
import { recordPerfSample } from '../../perfLogger';
import { getSharedWebGpuContext } from '../../webgpuShared';

type GPUCanvasContextLike = any;
type GPUDeviceLike = any;
type GPURenderPipelineLike = any;
type GPUBufferLike = any;
type GPUTextureLike = any;
type GPUBindGroupLike = any;

type ShapeBounds = {
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
};

type PreparedShape = {
    color: [number, number, number, number];
    bounds: ShapeBounds;
    rasterBounds: {
        offsetX: number;
        offsetY: number;
        width: number;
        height: number;
    };
    atlasRegion: {
        atlasX: number;
        atlasY: number;
        atlasWidth: number;
        atlasHeight: number;
    };
    orientedBounds: ProjectedPartShape['orientedBounds'];
    loopRanges: Uint32Array;
    loopPoints: Float32Array;
};

type ShapeGpuResource = {
    fillUniformBuffer: GPUBufferLike;
    fillBindGroup: GPUBindGroupLike;
    vertexBuffer: GPUBufferLike;
    vertexCount: number;
    loopRangesBuffer: GPUBufferLike;
    loopPointsBuffer: GPUBufferLike;
};

const GPUBufferUsageUniform = 0x0040;
const GPUBufferUsageVertex = 0x0020;
const GPUBufferUsageCopyDst = 0x0008;
const GPUBufferUsageStorage = 0x0080;
const EDGE_COLOR: [number, number, number, number] = [16 / 255, 16 / 255, 16 / 255, 1];

const hexToRgba = (hex: string, alpha: number): [number, number, number, number] => {
    const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
    return [
        Number.parseInt(normalized.slice(0, 2), 16) / 255,
        Number.parseInt(normalized.slice(2, 4), 16) / 255,
        Number.parseInt(normalized.slice(4, 6), 16) / 255,
        alpha,
    ];
};

const getShapeBounds = (
    shape: ProjectedPartShape,
    viewportWidth: number,
    viewportHeight: number,
): ShapeBounds | null => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    shape.loops.forEach((loop) => {
        loop.forEach((point) => {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        });
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }

    const padding = 2;
    const offsetX = Math.max(0, Math.floor(minX) - padding);
    const offsetY = Math.max(0, Math.floor(minY) - padding);
    const endX = Math.min(viewportWidth, Math.ceil(maxX) + padding);
    const endY = Math.min(viewportHeight, Math.ceil(maxY) + padding);
    const width = endX - offsetX;
    const height = endY - offsetY;
    if (width <= 0 || height <= 0) {
        return null;
    }

    return { offsetX, offsetY, width, height };
};

const flattenLoops = (shape: ProjectedPartShape) => {
    const loopRanges = new Uint32Array(shape.loops.length * 4);
    const loopPoints = new Float32Array(
        shape.loops.reduce((total, loop) => total + loop.length * 2, 0),
    );
    let pointOffset = 0;

    shape.loops.forEach((loop, loopIndex) => {
        loopRanges[loopIndex * 4] = pointOffset / 2;
        loopRanges[loopIndex * 4 + 1] = loop.length;
        loopRanges[loopIndex * 4 + 2] = 0;
        loopRanges[loopIndex * 4 + 3] = 0;
        loop.forEach((point) => {
            loopPoints[pointOffset] = point.x;
            loopPoints[pointOffset + 1] = point.y;
            pointOffset += 2;
        });
    });

    return {
        loopRanges,
        loopPoints,
    };
};

const buildPreparedShape = (
    shape: ProjectedPartShape,
    viewportWidth: number,
    viewportHeight: number,
    settings: ProjectionOverlaySettings,
): PreparedShape | null => {
    const bounds = getShapeBounds(shape, viewportWidth, viewportHeight);
    if (!bounds) {
        return null;
    }

    const flattenedLoops = flattenLoops(shape);
    return {
        color: hexToRgba(shape.color, settings.opacity),
        bounds,
        rasterBounds: shape.rasterBounds,
        atlasRegion: shape.atlasRegion,
        orientedBounds: shape.orientedBounds,
        loopRanges: flattenedLoops.loopRanges,
        loopPoints: flattenedLoops.loopPoints,
    };
};

export class GpuOverlayComposer {
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private context: GPUCanvasContextLike | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private format: string | null = null;
    private fillPipeline: GPURenderPipelineLike | null = null;
    private bindGroupLayout: any = null;
    private depthTexture: GPUTextureLike | null = null;
    private depthTextureWidth = 0;
    private depthTextureHeight = 0;
    private pendingDisposables = new Map<number, Array<{ destroy: () => void }>>();
    private latestRenderId = 0;

    async render(
        canvas: HTMLCanvasElement,
        shapes: ProjectedPartShape[],
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
        depthAtlas: GpuDepthAtlasState | null,
    ) {
        const totalStart = performance.now();
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return false;
        }

        const prepareStart = performance.now();
        const preparedShapes = shapes
            .map((shape) => buildPreparedShape(shape, viewportWidth, viewportHeight, settings))
            .filter((shape): shape is PreparedShape => shape !== null);
        const prepareMs = performance.now() - prepareStart;
        if (preparedShapes.length === 0 || !depthAtlas) {
            await this.clear(canvas, viewportWidth, viewportHeight);
            return false;
        }

        const device = await this.getDevice();
        if (!device) {
            return false;
        }

        const renderId = this.latestRenderId + 1;
        this.latestRenderId = renderId;

        this.configureCanvas(canvas, device, viewportWidth, viewportHeight);
        this.ensureDepthTexture(device, canvas.width, canvas.height);
        this.ensurePipelines(device);

        const resourceStart = performance.now();
        const resources = preparedShapes.map((shape) =>
            this.createShapeResource(
                device,
                shape,
                viewportWidth,
                viewportHeight,
                settings,
                depthAtlas,
            ),
        );
        const resourceMs = performance.now() - resourceStart;

        const encodeStart = performance.now();
        const currentTexture = this.context!.getCurrentTexture();
        const commandEncoder = device.createCommandEncoder();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: currentTexture.createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthTexture!.createView(),
                depthClearValue: 1,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        resources.forEach((resource) => {
            renderPass.setPipeline(this.fillPipeline);
            renderPass.setBindGroup(0, resource.fillBindGroup);
            renderPass.setVertexBuffer(0, resource.vertexBuffer);
            renderPass.draw(resource.vertexCount);
        });

        renderPass.end();
        const encodeMs = performance.now() - encodeStart;

        const submitStart = performance.now();
        device.queue.submit([commandEncoder.finish()]);
        const submitMs = performance.now() - submitStart;

        const frameResources = resources.flatMap((resource) => [
            resource.fillUniformBuffer,
            resource.vertexBuffer,
            resource.loopRangesBuffer,
            resource.loopPointsBuffer,
        ]);
        this.pendingDisposables.set(renderId, frameResources);
        void device.queue.onSubmittedWorkDone().then(() => {
            const disposables = this.pendingDisposables.get(renderId);
            this.pendingDisposables.delete(renderId);
            disposables?.forEach((resource) => resource.destroy());
        });

        recordPerfSample({
            label: 'gpu-composer',
            values: {
                prepareShapes: prepareMs,
                createResources: resourceMs,
                encode: encodeMs,
                submit: submitMs,
                total: performance.now() - totalStart,
            },
        });

        return true;
    }

    async clear(canvas: HTMLCanvasElement, viewportWidth: number, viewportHeight: number) {
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return;
        }

        const device = await this.getDevice();
        if (!device) {
            const context = canvas.getContext('2d');
            context?.setTransform(1, 0, 0, 1, 0, 0);
            context?.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        this.configureCanvas(canvas, device, viewportWidth, viewportHeight);
        const currentTexture = this.context!.getCurrentTexture();
        const commandEncoder = device.createCommandEncoder();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: currentTexture.createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        renderPass.end();
        device.queue.submit([commandEncoder.finish()]);
    }

    private async getDevice() {
        if (!this.devicePromise) {
            this.devicePromise = getSharedWebGpuContext().getDevice();
        }
        return this.devicePromise;
    }

    private configureCanvas(
        canvas: HTMLCanvasElement,
        device: GPUDeviceLike,
        viewportWidth: number,
        viewportHeight: number,
    ) {
        const pixelRatio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(viewportWidth * pixelRatio));
        const height = Math.max(1, Math.round(viewportHeight * pixelRatio));

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        canvas.style.width = `${viewportWidth}px`;
        canvas.style.height = `${viewportHeight}px`;

        if (!this.canvas || this.canvas !== canvas) {
            this.canvas = canvas;
            this.context = canvas.getContext('webgpu') as GPUCanvasContextLike | null;
        }

        if (!this.context) {
            throw new Error('WebGPU canvas context is not available.');
        }

        const preferredFormat = getSharedWebGpuContext().getPreferredCanvasFormat();
        if (this.format !== preferredFormat) {
            this.context.configure({
                device,
                format: preferredFormat,
                alphaMode: 'premultiplied',
            });
            this.format = preferredFormat;
        }
    }

    private ensurePipelines(device: GPUDeviceLike) {
        if (this.fillPipeline) {
            return;
        }

        const shaderModule = device.createShaderModule({
            code: `
struct Uniforms {
    bounds: vec4<f32>,
    viewportStroke: vec4<f32>,
    rasterBounds: vec4<f32>,
    atlasRegion: vec4<f32>,
    obbCenterExtents: vec4<f32>,
    obbAxisXy: vec4<f32>,
    color: vec4<f32>,
    edgeColor: vec4<f32>,
}

struct VertexInput {
    @location(0) position: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) screenPosition: vec2<f32>,
}

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<storage, read> loopRanges: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> loopPoints: array<vec2<f32>>;
@group(0) @binding(2) var depthAtlasTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

fn clampPixel(x: i32, lower: i32, upper: i32) -> i32 {
    return max(lower, min(upper, x));
}

fn readLoopPoint(index: u32) -> vec2<f32> {
    return loopPoints[index];
}

fn isInsideShape(screenPosition: vec2<f32>) -> bool {
    var windingParity = 0u;
    let loopCount = arrayLength(&loopRanges);
    for (var loopIndex = 0u; loopIndex < loopCount; loopIndex += 1u) {
        let range = loopRanges[loopIndex];
        let start = range.x;
        let count = range.y;
        if (count < 3u) {
            continue;
        }

        for (var pointIndex = 0u; pointIndex < count; pointIndex += 1u) {
            let current = readLoopPoint(start + pointIndex);
            let previous = readLoopPoint(start + ((pointIndex + count - 1u) % count));
            let crosses = (current.y > screenPosition.y) != (previous.y > screenPosition.y);
            if (!crosses) {
                continue;
            }

            let intersectionX =
                ((previous.x - current.x) * (screenPosition.y - current.y)) / (previous.y - current.y) + current.x;
            if (intersectionX > screenPosition.x) {
                windingParity = windingParity ^ 1u;
            }
        }
    }

    return windingParity == 1u;
}

fn pointToSegmentDistance(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
    let delta = end - start;
    let lengthSquared = dot(delta, delta);
    if (lengthSquared <= 0.00001) {
        return distance(point, start);
    }

    let t = clamp(dot(point - start, delta) / lengthSquared, 0.0, 1.0);
    let projected = start + delta * t;
    return distance(point, projected);
}

fn isBoundary(screenPosition: vec2<f32>) -> bool {
    let strokeRadius = max(0.5, uniforms.viewportStroke.z);
    var minimumDistance = 1e20;
    let loopCount = arrayLength(&loopRanges);
    for (var loopIndex = 0u; loopIndex < loopCount; loopIndex += 1u) {
        let range = loopRanges[loopIndex];
        let start = range.x;
        let count = range.y;
        if (count < 2u) {
            continue;
        }

        for (var pointIndex = 0u; pointIndex < count; pointIndex += 1u) {
            let current = readLoopPoint(start + pointIndex);
            let next = readLoopPoint(start + ((pointIndex + 1u) % count));
            minimumDistance = min(minimumDistance, pointToSegmentDistance(screenPosition, current, next));
        }
    }

    return minimumDistance <= strokeRadius;
}

fn sampleDepthNdc(screenPosition: vec2<f32>) -> f32 {
    let rawLocalX = screenPosition.x - uniforms.rasterBounds.x;
    let rawLocalY = screenPosition.y - uniforms.rasterBounds.y;
    var sampleScreen = screenPosition;

    if (
        rawLocalX < 0.0 ||
        rawLocalY < 0.0 ||
        rawLocalX >= uniforms.rasterBounds.z ||
        rawLocalY >= uniforms.rasterBounds.w
    ) {
        let center = uniforms.obbCenterExtents.xy;
        let extents = uniforms.obbCenterExtents.zw;
        let axisX = uniforms.obbAxisXy.xy;
        let axisY = uniforms.obbAxisXy.zw;
        let delta = screenPosition - center;
        let localObb = vec2<f32>(dot(delta, axisX), dot(delta, axisY));
        let scale = max(
            abs(localObb.x) / max(extents.x, 0.5),
            abs(localObb.y) / max(extents.y, 0.5),
        );
        if (scale > 1.0) {
            let boundaryLocal = localObb / scale;
            sampleScreen =
                center +
                axisX * boundaryLocal.x +
                axisY * boundaryLocal.y;
        }
    }

    let atlasLocalX = clampPixel(
        i32(floor(sampleScreen.x - uniforms.rasterBounds.x)),
        0,
        i32(uniforms.rasterBounds.z) - 1,
    );
    let atlasLocalY = clampPixel(
        i32(floor(sampleScreen.y - uniforms.rasterBounds.y)),
        0,
        i32(uniforms.rasterBounds.w) - 1,
    );
    let atlasCoords = vec2<i32>(
        i32(uniforms.atlasRegion.x) + atlasLocalX,
        i32(uniforms.atlasRegion.y) + atlasLocalY,
    );
    let depth = textureLoad(depthAtlasTexture, atlasCoords, 0).r;
    if (depth < 1e19) {
        return depth;
    }

    let center = uniforms.obbCenterExtents.xy;
    let extents = uniforms.obbCenterExtents.zw;
    let axisX = uniforms.obbAxisXy.xy;
    let axisY = uniforms.obbAxisXy.zw;
    let delta = screenPosition - center;
    let localObb = vec2<f32>(dot(delta, axisX), dot(delta, axisY));
    let scale = max(
        max(
            abs(localObb.x) / max(extents.x, 0.5),
            abs(localObb.y) / max(extents.y, 0.5),
        ),
        1.0,
    );
    let boundaryLocal = localObb / scale;
    let boundaryScreen =
        center +
        axisX * boundaryLocal.x +
        axisY * boundaryLocal.y;
    let boundaryLocalX = clampPixel(
        i32(floor(boundaryScreen.x - uniforms.rasterBounds.x)),
        0,
        i32(uniforms.rasterBounds.z) - 1,
    );
    let boundaryLocalY = clampPixel(
        i32(floor(boundaryScreen.y - uniforms.rasterBounds.y)),
        0,
        i32(uniforms.rasterBounds.w) - 1,
    );
    let boundaryAtlasCoords = vec2<i32>(
        i32(uniforms.atlasRegion.x) + boundaryLocalX,
        i32(uniforms.atlasRegion.y) + boundaryLocalY,
    );
    return textureLoad(depthAtlasTexture, boundaryAtlasCoords, 0).r;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let clipX = input.position.x / uniforms.viewportStroke.x * 2.0 - 1.0;
    let clipY = 1.0 - input.position.y / uniforms.viewportStroke.y * 2.0;
    output.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
    output.screenPosition = input.position;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
    if (!isInsideShape(input.screenPosition)) {
        discard;
    }

    let depthNdc = sampleDepthNdc(input.screenPosition);
    var output: FragmentOutput;
    output.color = select(
        uniforms.color,
        uniforms.edgeColor,
        uniforms.viewportStroke.w > 0.5 && isBoundary(input.screenPosition),
    );
    output.depth = clamp(depthNdc * 0.5 + 0.5, 0.0, 1.0);
    return output;
}
            `,
        });

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        const commonDescriptor = {
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout],
            }),
            vertex: {
                module: shaderModule,
                entryPoint: 'vertexMain',
                buffers: [
                    {
                        arrayStride: Float32Array.BYTES_PER_ELEMENT * 2,
                        attributes: [
                            {
                                shaderLocation: 0,
                                offset: 0,
                                format: 'float32x2',
                            },
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fragmentMain',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        };

        this.fillPipeline = device.createRenderPipeline(commonDescriptor);
    }

    private ensureDepthTexture(device: GPUDeviceLike, width: number, height: number) {
        if (this.depthTexture && this.depthTextureWidth === width && this.depthTextureHeight === height) {
            return;
        }

        this.depthTexture?.destroy();
        this.depthTexture = device.createTexture({
            size: { width, height },
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureWidth = width;
        this.depthTextureHeight = height;
    }

    private createShapeResource(
        device: GPUDeviceLike,
        shape: PreparedShape,
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
        depthAtlas: GpuDepthAtlasState,
    ): ShapeGpuResource {
        const loopRangesBuffer = this.createBuffer(
            device,
            shape.loopRanges,
            GPUBufferUsageStorage | GPUBufferUsageCopyDst,
        );
        const loopPointsBuffer = this.createBuffer(
            device,
            shape.loopPoints,
            GPUBufferUsageStorage | GPUBufferUsageCopyDst,
        );

        const vertices = new Float32Array([
            shape.bounds.offsetX, shape.bounds.offsetY,
            shape.bounds.offsetX + shape.bounds.width, shape.bounds.offsetY,
            shape.bounds.offsetX, shape.bounds.offsetY + shape.bounds.height,
            shape.bounds.offsetX, shape.bounds.offsetY + shape.bounds.height,
            shape.bounds.offsetX + shape.bounds.width, shape.bounds.offsetY,
            shape.bounds.offsetX + shape.bounds.width, shape.bounds.offsetY + shape.bounds.height,
        ]);
        const vertexBuffer = this.createBuffer(device, vertices, GPUBufferUsageVertex | GPUBufferUsageCopyDst);

        const fillUniformBuffer = this.createBuffer(
            device,
            new Float32Array([
                shape.bounds.offsetX,
                shape.bounds.offsetY,
                shape.bounds.width,
                shape.bounds.height,
                viewportWidth,
                viewportHeight,
                settings.strokeWidth,
                settings.showContours ? 1 : 0,
                shape.rasterBounds.offsetX,
                shape.rasterBounds.offsetY,
                shape.rasterBounds.width,
                shape.rasterBounds.height,
                shape.atlasRegion.atlasX,
                shape.atlasRegion.atlasY,
                depthAtlas.width,
                depthAtlas.height,
                shape.orientedBounds.center.x,
                shape.orientedBounds.center.y,
                shape.orientedBounds.extentX,
                shape.orientedBounds.extentY,
                shape.orientedBounds.axisX.x,
                shape.orientedBounds.axisX.y,
                shape.orientedBounds.axisY.x,
                shape.orientedBounds.axisY.y,
                ...shape.color,
                ...EDGE_COLOR,
            ]),
            GPUBufferUsageUniform | GPUBufferUsageCopyDst,
        );
        const fillBindGroup = device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: loopRangesBuffer } },
                { binding: 1, resource: { buffer: loopPointsBuffer } },
                { binding: 2, resource: depthAtlas.texture.createView() },
                { binding: 3, resource: { buffer: fillUniformBuffer } },
            ],
        });

        return {
            fillUniformBuffer,
            fillBindGroup,
            vertexBuffer,
            vertexCount: 6,
            loopRangesBuffer,
            loopPointsBuffer,
        };
    }

    private createBuffer(device: GPUDeviceLike, data: Float32Array | Uint32Array, usage: number) {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage,
            mappedAtCreation: true,
        });
        if (data instanceof Float32Array) {
            new Float32Array(buffer.getMappedRange()).set(data);
        } else {
            new Uint32Array(buffer.getMappedRange()).set(data);
        }
        buffer.unmap();
        return buffer;
    }
}

let composer: GpuOverlayComposer | null = null;

export const getGpuOverlayComposer = () => {
    composer ??= new GpuOverlayComposer();
    return composer;
};
