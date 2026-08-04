import * as THREE from 'three';
import type { ProjectedPartShape, ProjectionOverlaySettings } from './partProjection';

type GPUAdapterLike = any;
type GPUCanvasContextLike = any;
type GPUDeviceLike = any;
type GPURenderPipelineLike = any;
type GPUBufferLike = any;
type GPUTextureLike = any;
type GPUBindGroupLike = any;

type VertexBufferResource = {
    buffer: GPUBufferLike;
    vertexCount: number;
};

type IndexBufferResource = {
    buffer: GPUBufferLike;
    indexCount: number;
    format: 'uint16' | 'uint32';
};

type ShapeGpuResource = {
    depthBuffer: GPUBufferLike;
    uniformBuffer: GPUBufferLike;
    bindGroup: GPUBindGroupLike;
    fillVertexBuffer: VertexBufferResource | null;
    fillIndexBuffer: IndexBufferResource | null;
    lineVertexBuffer: VertexBufferResource | null;
};

type UniformPayload = {
    bounds: [number, number, number, number];
    viewport: [number, number];
    color: [number, number, number, number];
};

const GPUBufferUsageMap = {
    vertex: 0x0020,
    index: 0x0010,
    uniform: 0x0040,
    storage: 0x0080,
    copyDst: 0x0008,
    renderAttachment: 0x0010,
};

const EDGE_COLOR: [number, number, number, number] = [16 / 255, 16 / 255, 16 / 255, 1];

const hexToRgba = (hex: string): [number, number, number, number] => {
    const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
    return [
        Number.parseInt(normalized.slice(0, 2), 16) / 255,
        Number.parseInt(normalized.slice(2, 4), 16) / 255,
        Number.parseInt(normalized.slice(4, 6), 16) / 255,
        1,
    ];
};

const getLoopArea = (loop: Array<{ x: number; y: number }>) => {
    let area = 0;
    for (let index = 0; index < loop.length; index += 1) {
        const current = loop[index];
        const next = loop[(index + 1) % loop.length];
        area += current.x * next.y - next.x * current.y;
    }
    return area * 0.5;
};

const normalizeLoopWinding = (loop: Array<{ x: number; y: number }>) =>
    getLoopArea(loop) < 0 ? [...loop].reverse() : loop;

const buildLoopTriangles = (loop: Array<{ x: number; y: number }>) => {
    if (loop.length < 3) {
        return null;
    }

    const normalizedLoop = normalizeLoopWinding(loop);
    const contour = normalizedLoop.map((point) => new THREE.Vector2(point.x, point.y));
    const triangleIndices = THREE.ShapeUtils.triangulateShape(contour, []);
    if (triangleIndices.length === 0) {
        return null;
    }

    const vertices = new Float32Array(normalizedLoop.length * 2);
    normalizedLoop.forEach((point, index) => {
        vertices[index * 2] = point.x;
        vertices[index * 2 + 1] = point.y;
    });

    const flatIndices = triangleIndices.flat();
    const useUint32 = normalizedLoop.length > 65535;
    const indices = useUint32 ? new Uint32Array(flatIndices) : new Uint16Array(flatIndices);

    return {
        vertices,
        indices,
        indexFormat: useUint32 ? ('uint32' as const) : ('uint16' as const),
    };
};

const buildStrokeTriangles = (loop: Array<{ x: number; y: number }>, strokeWidth: number) => {
    if (loop.length < 2) {
        return null;
    }

    const normalizedLoop = normalizeLoopWinding(loop);
    const halfWidth = Math.max(0.5, strokeWidth * 0.5);
    const vertices: number[] = [];

    for (let index = 0; index < normalizedLoop.length; index += 1) {
        const start = normalizedLoop[index];
        const end = normalizedLoop[(index + 1) % normalizedLoop.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-5) {
            continue;
        }

        const normalX = -dy / length;
        const normalY = dx / length;
        const offsetX = normalX * halfWidth;
        const offsetY = normalY * halfWidth;

        const a = [start.x + offsetX, start.y + offsetY];
        const b = [start.x - offsetX, start.y - offsetY];
        const c = [end.x + offsetX, end.y + offsetY];
        const d = [end.x - offsetX, end.y - offsetY];

        vertices.push(
            a[0], a[1],
            b[0], b[1],
            c[0], c[1],
            c[0], c[1],
            b[0], b[1],
            d[0], d[1],
        );
    }

    if (vertices.length === 0) {
        return null;
    }

    return new Float32Array(vertices);
};

export class GpuOverlayComposer {
    private adapterPromise: Promise<GPUAdapterLike | null> | null = null;
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private device: GPUDeviceLike | null = null;
    private context: GPUCanvasContextLike | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private format: string | null = null;
    private fillPipeline: GPURenderPipelineLike | null = null;
    private linePipeline: GPURenderPipelineLike | null = null;
    private bindGroupLayout: any = null;
    private depthTexture: GPUTextureLike | null = null;
    private depthTextureWidth = 0;
    private depthTextureHeight = 0;
    private pendingDisposables = new Map<number, Array<{ destroy: () => void }>>();
    private latestRenderId = 0;

    dispose() {
        this.destroyDepthTexture();
        this.pendingDisposables.forEach((resources) => {
            resources.forEach((resource) => resource.destroy());
        });
        this.pendingDisposables.clear();
        this.fillPipeline = null;
        this.linePipeline = null;
        this.bindGroupLayout = null;
        this.context = null;
        this.canvas = null;
        this.device = null;
        this.devicePromise = null;
        this.adapterPromise = null;
    }

    async render(
        canvas: HTMLCanvasElement,
        shapes: ProjectedPartShape[],
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
    ) {
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return false;
        }

        const filteredShapes = shapes.filter((shape) => shape.loops.length > 0);
        if (filteredShapes.length === 0) {
            const context = canvas.getContext('2d');
            context?.clearRect(0, 0, canvas.width, canvas.height);
            return false;
        }

        const device = await this.ensureDevice();
        if (!device) {
            return false;
        }

        const renderId = this.latestRenderId + 1;
        this.latestRenderId = renderId;

        this.configureCanvas(canvas, device, viewportWidth, viewportHeight);
        this.ensureDepthTexture(device, canvas.width, canvas.height);
        this.ensurePipelines(device);

        const resources = filteredShapes
            .slice()
            .sort((left, right) => right.depth - left.depth)
            .flatMap((shape) => this.createShapeResources(device, shape, viewportWidth, viewportHeight, settings));

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
            if (resource.fillVertexBuffer && resource.fillIndexBuffer) {
                renderPass.setPipeline(this.fillPipeline);
                renderPass.setBindGroup(0, resource.bindGroup);
                renderPass.setVertexBuffer(0, resource.fillVertexBuffer.buffer);
                renderPass.setIndexBuffer(resource.fillIndexBuffer.buffer, resource.fillIndexBuffer.format);
                renderPass.drawIndexed(resource.fillIndexBuffer.indexCount);
            }

            if (resource.lineVertexBuffer) {
                renderPass.setPipeline(this.linePipeline);
                renderPass.setBindGroup(0, resource.bindGroup);
                renderPass.setVertexBuffer(0, resource.lineVertexBuffer.buffer);
                renderPass.draw(resource.lineVertexBuffer.vertexCount);
            }
        });

        renderPass.end();
        device.queue.submit([commandEncoder.finish()]);

        const frameResources = resources.flatMap((resource) => {
            const disposables = [
                resource.depthBuffer,
                resource.uniformBuffer,
            ] as Array<{ destroy: () => void }>;
            if (resource.fillVertexBuffer) {
                disposables.push(resource.fillVertexBuffer.buffer);
            }
            if (resource.fillIndexBuffer) {
                disposables.push(resource.fillIndexBuffer.buffer);
            }
            if (resource.lineVertexBuffer) {
                disposables.push(resource.lineVertexBuffer.buffer);
            }
            return disposables;
        });
        this.pendingDisposables.set(renderId, frameResources);

        void device.queue.onSubmittedWorkDone().then(() => {
            const completed = this.pendingDisposables.get(renderId);
            this.pendingDisposables.delete(renderId);
            completed?.forEach((resource) => resource.destroy());
        });

        return true;
    }

    private async ensureDevice() {
        if (this.device) {
            return this.device;
        }

        if (!this.adapterPromise) {
            this.adapterPromise = (async () => {
                const gpuNavigator = navigator as Navigator & {
                    gpu?: {
                        requestAdapter?: () => Promise<GPUAdapterLike | null>;
                        getPreferredCanvasFormat?: () => string;
                    };
                };
                return (await gpuNavigator.gpu?.requestAdapter?.()) ?? null;
            })();
        }

        if (!this.devicePromise) {
            this.devicePromise = (async () => {
                const adapter = await this.adapterPromise;
                if (!adapter) {
                    return null;
                }
                const device = await adapter.requestDevice();
                this.device = device;
                return device;
            })();
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

        const gpuNavigator = navigator as Navigator & {
            gpu?: { getPreferredCanvasFormat?: () => string };
        };
        const preferredFormat = gpuNavigator.gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
        if (this.format !== preferredFormat || this.depthTextureWidth !== width || this.depthTextureHeight !== height) {
            this.context.configure({
                device,
                format: preferredFormat,
                alphaMode: 'premultiplied',
            });
            this.format = preferredFormat;
        }
    }

    private ensurePipelines(device: GPUDeviceLike) {
        if (this.fillPipeline && this.linePipeline) {
            return;
        }

        const shaderModule = device.createShaderModule({
            code: `
struct Uniforms {
    bounds: vec4<f32>,
    viewport: vec2<f32>,
    color: vec4<f32>,
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

@group(0) @binding(0) var<storage, read> depthField: array<f32>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

fn clampPixel(x: i32, lower: i32, upper: i32) -> i32 {
    return max(lower, min(upper, x));
}

fn sampleDepth(screenPosition: vec2<f32>) -> f32 {
    let localX = clampPixel(i32(floor(screenPosition.x - uniforms.bounds.x)), 0, i32(uniforms.bounds.z) - 1);
    let localY = clampPixel(i32(floor(screenPosition.y - uniforms.bounds.y)), 0, i32(uniforms.bounds.w) - 1);
    let index = localY * i32(uniforms.bounds.z) + localX;
    return depthField[index];
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
    var output: FragmentOutput;
    let ndcDepth = sampleDepth(input.screenPosition);
    output.color = uniforms.color;
    output.depth = clamp(ndcDepth * 0.5 + 0.5, 0.0, 1.0);
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
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        const commonDescriptor = {
            layout: pipelineLayout,
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
                targets: [
                    {
                        format: this.format,
                    },
                ],
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
        this.linePipeline = device.createRenderPipeline({
            ...commonDescriptor,
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
            },
        });
    }

    private ensureDepthTexture(device: GPUDeviceLike, width: number, height: number) {
        if (this.depthTexture && this.depthTextureWidth === width && this.depthTextureHeight === height) {
            return;
        }

        this.destroyDepthTexture();
        this.depthTexture = device.createTexture({
            size: { width, height },
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureWidth = width;
        this.depthTextureHeight = height;
    }

    private destroyDepthTexture() {
        this.depthTexture?.destroy();
        this.depthTexture = null;
        this.depthTextureWidth = 0;
        this.depthTextureHeight = 0;
    }

    private createShapeResources(
        device: GPUDeviceLike,
        shape: ProjectedPartShape,
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
    ) {
        const resources: ShapeGpuResource[] = [];

        shape.loops.forEach((loop) => {
            const fill = buildLoopTriangles(loop);
            const lineVertices = buildStrokeTriangles(loop, settings.strokeWidth);
            if (!fill && !lineVertices) {
                return;
            }

            const depthBuffer = this.createBuffer(
                device,
                shape.depthField.values,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            );
            const uniformPayload = new Float32Array([
                shape.depthField.offsetX,
                shape.depthField.offsetY,
                shape.depthField.width,
                shape.depthField.height,
                viewportWidth,
                viewportHeight,
                0,
                0,
                ...hexToRgba(shape.color),
            ]);
            const uniformBuffer = this.createBuffer(
                device,
                uniformPayload,
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            );
            const bindGroup = device.createBindGroup({
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: depthBuffer } },
                    { binding: 1, resource: { buffer: uniformBuffer } },
                ],
            });

            resources.push({
                depthBuffer,
                uniformBuffer,
                bindGroup,
                fillVertexBuffer: fill
                    ? {
                          buffer: this.createBuffer(device, fill.vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST),
                          vertexCount: fill.vertices.length / 2,
                      }
                    : null,
                fillIndexBuffer: fill
                    ? {
                          buffer: this.createBuffer(device, fill.indices, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST),
                          indexCount: fill.indices.length,
                          format: fill.indexFormat,
                      }
                    : null,
                lineVertexBuffer: lineVertices
                    ? {
                          buffer: this.createBuffer(device, lineVertices, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST),
                          vertexCount: lineVertices.length / 2,
                      }
                    : null,
            });
        });

        return resources;
    }

    private createBuffer(
        device: GPUDeviceLike,
        data: Float32Array | Uint16Array | Uint32Array,
        usage: number,
    ) {
        const alignedSize = Math.ceil(data.byteLength / 4) * 4;
        const buffer = device.createBuffer({
            size: alignedSize,
            usage,
            mappedAtCreation: true,
        });
        const mapped = buffer.getMappedRange();
        if (data instanceof Float32Array) {
            new Float32Array(mapped).set(data);
        } else if (data instanceof Uint16Array) {
            new Uint16Array(mapped).set(data);
        } else {
            new Uint32Array(mapped).set(data);
        }
        buffer.unmap();
        return buffer;
    }
}
