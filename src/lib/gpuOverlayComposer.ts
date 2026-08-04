import type { GpuRasterAtlasState } from './gpuPartRasterizer';
import type { ProjectedPartShape, ProjectionOverlaySettings } from './partProjection';
import { getSharedWebGpuContext } from './webgpuShared';

type GPUCanvasContextLike = any;
type GPUDeviceLike = any;
type GPURenderPipelineLike = any;
type GPUBufferLike = any;
type GPUTextureLike = any;
type GPUBindGroupLike = any;

type Point2D = { x: number; y: number };

type ShapeBounds = {
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
};

type PreparedShape = {
    color: [number, number, number, number];
    bounds: ShapeBounds;
    maskValues: Uint8Array;
    depthValues: Float32Array;
};

type ShapeGpuResource = {
    fillUniformBuffer: GPUBufferLike;
    fillBindGroup: GPUBindGroupLike;
    vertexBuffer: GPUBufferLike;
    vertexCount: number;
    maskTexture: GPUTextureLike;
    depthTexture: GPUTextureLike;
};

const GPUBufferUsageUniform = 0x0040;
const GPUBufferUsageVertex = 0x0020;
const GPUBufferUsageCopyDst = 0x0008;
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

    const padding = Math.max(2, Math.ceil(shape.depthField.width > 0 && shape.depthField.height > 0 ? 1 : 0));
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

const buildLoopCoverageMask = (
    shape: ProjectedPartShape,
    bounds: ShapeBounds,
    simplifyEpsilon: number,
) => {
    if (simplifyEpsilon <= 0.001) {
        return {
            offsetX: shape.coverageMask.offsetX,
            offsetY: shape.coverageMask.offsetY,
            width: shape.coverageMask.width,
            height: shape.coverageMask.height,
            values: shape.coverageMask.values,
        };
    }

    const mask = new Uint8Array(bounds.width * bounds.height);
    const intersections: number[] = [];

    for (let localY = 0; localY < bounds.height; localY += 1) {
        intersections.length = 0;
        const sampleY = bounds.offsetY + localY + 0.5;

        shape.loops.forEach((loop) => {
            for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index, index += 1) {
                const current = loop[index];
                const prior = loop[previous];
                const crosses = (current.y > sampleY) !== (prior.y > sampleY);
                if (!crosses) {
                    continue;
                }

                const intersectionX =
                    ((prior.x - current.x) * (sampleY - current.y)) / (prior.y - current.y) + current.x;
                intersections.push(intersectionX);
            }
        });

        if (intersections.length < 2) {
            continue;
        }

        intersections.sort((left, right) => left - right);

        for (let index = 0; index + 1 < intersections.length; index += 2) {
            const startX = intersections[index];
            const endX = intersections[index + 1];
            const localStartX = Math.max(0, Math.ceil(startX - bounds.offsetX - 0.5));
            const localEndX = Math.min(bounds.width - 1, Math.floor(endX - bounds.offsetX - 0.5));
            for (let localX = localStartX; localX <= localEndX; localX += 1) {
                mask[localY * bounds.width + localX] = 255;
            }
        }
    }

    return {
        offsetX: bounds.offsetX,
        offsetY: bounds.offsetY,
        width: bounds.width,
        height: bounds.height,
        values: mask,
    };
};

const sampleCpuDepth = (shape: ProjectedPartShape, x: number, y: number) => {
    if (shape.depthField.kind !== 'cpu') {
        return Number.POSITIVE_INFINITY;
    }
    const localX = Math.max(0, Math.min(shape.depthField.width - 1, Math.floor(x - shape.depthField.offsetX)));
    const localY = Math.max(0, Math.min(shape.depthField.height - 1, Math.floor(y - shape.depthField.offsetY)));
    return shape.depthField.values[localY * shape.depthField.width + localX];
};

const buildPreparedShape = (
    shape: ProjectedPartShape,
    viewportWidth: number,
    viewportHeight: number,
    settings: ProjectionOverlaySettings,
): PreparedShape | null => {
    const bounds = getShapeBounds(shape, viewportWidth, viewportHeight);
    if (!bounds || shape.depthField.kind !== 'cpu') {
        return null;
    }

    const coverageMask = buildLoopCoverageMask(shape, bounds, settings.simplifyEpsilon);
    const depthValues = new Float32Array(coverageMask.width * coverageMask.height);
    depthValues.fill(Number.POSITIVE_INFINITY);

    for (let localY = 0; localY < coverageMask.height; localY += 1) {
        const rowOffset = localY * coverageMask.width;
        for (let localX = 0; localX < coverageMask.width; localX += 1) {
            if (coverageMask.values[rowOffset + localX] === 0) {
                continue;
            }

            const x = coverageMask.offsetX + localX;
            const y = coverageMask.offsetY + localY;
            depthValues[rowOffset + localX] = sampleCpuDepth(shape, x + 0.5, y + 0.5);
        }
    }

    return {
        color: hexToRgba(shape.color, settings.opacity),
        bounds,
        maskValues: coverageMask.values,
        depthValues,
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
        _atlasState: GpuRasterAtlasState | null,
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
    ) {
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return false;
        }

        const preparedShapes = shapes
            .map((shape) => buildPreparedShape(shape, viewportWidth, viewportHeight, settings))
            .filter((shape): shape is PreparedShape => shape !== null);
        if (preparedShapes.length === 0) {
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

        const resources = preparedShapes.map((shape) => this.createShapeResource(device, shape, viewportWidth, viewportHeight, settings));
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
        device.queue.submit([commandEncoder.finish()]);

        const frameResources = resources.flatMap((resource) => [
            resource.fillUniformBuffer,
            resource.vertexBuffer,
            resource.maskTexture,
            resource.depthTexture,
        ]);
        this.pendingDisposables.set(renderId, frameResources);
        void device.queue.onSubmittedWorkDone().then(() => {
            const disposables = this.pendingDisposables.get(renderId);
            this.pendingDisposables.delete(renderId);
            disposables?.forEach((resource) => resource.destroy());
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
    viewport: vec2<f32>,
    strokeRadius: f32,
    showContours: f32,
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

@group(0) @binding(0) var maskTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

fn clampPixel(x: i32, lower: i32, upper: i32) -> i32 {
    return max(lower, min(upper, x));
}

fn sampleLocalCoords(screenPosition: vec2<f32>) -> vec2<i32> {
    let localX = clampPixel(i32(floor(screenPosition.x - uniforms.bounds.x)), 0, i32(uniforms.bounds.z) - 1);
    let localY = clampPixel(i32(floor(screenPosition.y - uniforms.bounds.y)), 0, i32(uniforms.bounds.w) - 1);
    return vec2<i32>(localX, localY);
}

fn sampleMask(localCoords: vec2<i32>) -> f32 {
    return textureLoad(maskTexture, localCoords, 0).r;
}

fn sampleDepthNdc(localCoords: vec2<i32>) -> f32 {
    return textureLoad(depthTexture, localCoords, 0).r;
}

fn isBaseBoundary(localCoords: vec2<i32>) -> bool {
    if (sampleMask(localCoords) < 0.5) {
        return false;
    }

    let neighbors = array<vec2<i32>, 4>(
        vec2<i32>(-1, 0),
        vec2<i32>(1, 0),
        vec2<i32>(0, -1),
        vec2<i32>(0, 1),
    );
    for (var index = 0; index < 4; index += 1) {
        let sampleCoords = localCoords + neighbors[index];
        if (
            sampleCoords.x < 0 ||
            sampleCoords.y < 0 ||
            sampleCoords.x >= i32(uniforms.bounds.z) ||
            sampleCoords.y >= i32(uniforms.bounds.w)
        ) {
            return true;
        }
        if (sampleMask(sampleCoords) < 0.5) {
            return true;
        }
    }

    return false;
}

fn isBoundary(localCoords: vec2<i32>) -> bool {
    let radius = max(1, i32(round(uniforms.strokeRadius)));
    for (var offsetY = -radius + 1; offsetY < radius; offsetY += 1) {
        for (var offsetX = -radius + 1; offsetX < radius; offsetX += 1) {
            let sampleX = localCoords.x + offsetX;
            let sampleY = localCoords.y + offsetY;
            if (sampleX < 0 || sampleY < 0 || sampleX >= i32(uniforms.bounds.z) || sampleY >= i32(uniforms.bounds.w)) {
                continue;
            }
            if (isBaseBoundary(vec2<i32>(sampleX, sampleY))) {
                return true;
            }
        }
    }
    return false;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let clipX = input.position.x / uniforms.viewport.x * 2.0 - 1.0;
    let clipY = 1.0 - input.position.y / uniforms.viewport.y * 2.0;
    output.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
    output.screenPosition = input.position;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
    let localCoords = sampleLocalCoords(input.screenPosition);
    let mask = sampleMask(localCoords);
    if (mask < 0.5) {
        discard;
    }

    let depthNdc = sampleDepthNdc(localCoords);
    var output: FragmentOutput;
    output.color = select(uniforms.color, uniforms.edgeColor, uniforms.showContours > 0.5 && isBoundary(localCoords));
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
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' },
                },
                {
                    binding: 2,
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
    ): ShapeGpuResource {
        const maskTexture = device.createTexture({
            size: { width: shape.bounds.width, height: shape.bounds.height, depthOrArrayLayers: 1 },
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: maskTexture },
            shape.maskValues,
            {
                bytesPerRow: shape.bounds.width,
                rowsPerImage: shape.bounds.height,
            },
            {
                width: shape.bounds.width,
                height: shape.bounds.height,
                depthOrArrayLayers: 1,
            },
        );

        const depthTexture = device.createTexture({
            size: { width: shape.bounds.width, height: shape.bounds.height, depthOrArrayLayers: 1 },
            format: 'r32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: depthTexture },
            shape.depthValues,
            {
                bytesPerRow: shape.bounds.width * Float32Array.BYTES_PER_ELEMENT,
                rowsPerImage: shape.bounds.height,
            },
            {
                width: shape.bounds.width,
                height: shape.bounds.height,
                depthOrArrayLayers: 1,
            },
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
                ...shape.color,
                ...EDGE_COLOR,
            ]),
            GPUBufferUsageUniform | GPUBufferUsageCopyDst,
        );
        const fillBindGroup = device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: maskTexture.createView() },
                { binding: 1, resource: depthTexture.createView() },
                { binding: 2, resource: { buffer: fillUniformBuffer } },
            ],
        });

        return {
            fillUniformBuffer,
            fillBindGroup,
            vertexBuffer,
            vertexCount: 6,
            maskTexture,
            depthTexture,
        };
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

let composer: GpuOverlayComposer | null = null;

export const getGpuOverlayComposer = () => {
    composer ??= new GpuOverlayComposer();
    return composer;
};
