import * as THREE from 'three';
import type { MeshProjectionCache } from '../../2DRenderShared/types';
import type { ProjectionPartSource } from '../../modelParts';
import { getSharedWebGpuContext } from '../../webgpuShared';

type MeshLike = THREE.Mesh | THREE.SkinnedMesh;

type MeshSnapshot = {
    mesh: MeshLike;
    positions: Float32Array;
    matrixWorld: Float32Array;
    bindMatrix: Float32Array;
    bindMatrixInverse: Float32Array;
};

type GpuRequest = {
    frameId: number;
    viewportWidth: number;
    viewportHeight: number;
    viewProjectionMatrix: Float32Array;
    meshSnapshots: MeshSnapshot[];
};

type GPUBufferLike = any;
type GPUBindGroupLike = any;
type GPUComputePipelineLike = any;
type GPUDeviceLike = any;
type GPUQueueLike = any;

type MeshGpuResources = {
    version: string;
    vertexCount: number;
    positionsBuffer: GPUBufferLike;
    uniformsBuffer: GPUBufferLike;
    projectedOutputBuffer: GPUBufferLike;
    projectedReadbackBuffer: GPUBufferLike;
    computeBindGroup: GPUBindGroupLike;
};

export type ProjectionFrameResult = {
    frameId: number;
    width: number;
    height: number;
    getProjectionCache: (mesh: MeshLike) => MeshProjectionCache | null;
};

const WORKGROUP_SIZE = 64;
const FLOATS_PER_PROJECTED_VERTEX = 4;
const FLOATS_PER_UNIFORMS = 16 * 4 + 4;
const GPUBufferUsageMapRead = 0x0001;
const GPUBufferUsageCopySrc = 0x0004;
const GPUBufferUsageCopyDst = 0x0008;
const GPUBufferUsageUniform = 0x0040;
const GPUBufferUsageStorage = 0x0080;

const flattenMatrix4 = (matrix: THREE.Matrix4) => matrix.elements.slice();

const toUniqueMeshes = (parts: ProjectionPartSource[]) => {
    const unique = new Set<MeshLike>();
    parts.forEach((part) => {
        unique.add(part.mesh);
    });
    return [...unique];
};

const toVec4FloatArray = (
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    fallbackW: number,
) => {
    const data = new Float32Array(attribute.count * 4);
    for (let index = 0; index < attribute.count; index += 1) {
        const offset = index * 4;
        data[offset] = attribute.getX(index);
        data[offset + 1] = attribute.getY(index);
        data[offset + 2] = attribute.itemSize > 2 ? attribute.getZ(index) : 0;
        data[offset + 3] = attribute.itemSize > 3 ? attribute.getW(index) : fallbackW;
    }
    return data;
};

/**
 * Match the position path used by Three.js' renderer/raycaster.  MMD facial
 * animation is stored as morph-target influences (嘴/眼睛), not bone motion.
 * Reading the raw position attribute and only calling applyBoneTransform()
 * silently drops those morphs from the projection pass.
 */
export const toAnimatedLocalPositions = (mesh: MeshLike) => {
    const positionAttribute = mesh.geometry.getAttribute('position');
    const positions = new Float32Array(positionAttribute.count * 4);
    const vector = new THREE.Vector3();

    for (let vertexIndex = 0; vertexIndex < positionAttribute.count; vertexIndex += 1) {
        // Mesh.getVertexPosition applies morph targets. SkinnedMesh overrides
        // it and then applies skinning, so this covers both animation paths
        // without applying the bone transform twice.
        mesh.getVertexPosition(vertexIndex, vector);
        const offset = vertexIndex * 4;
        positions[offset] = vector.x;
        positions[offset + 1] = vector.y;
        positions[offset + 2] = vector.z;
        positions[offset + 3] = 1;
    }

    return positions;
};

class WebGpuProjectionPipeline {
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private device: GPUDeviceLike | null = null;
    private queue: GPUQueueLike | null = null;
    private computePipeline: GPUComputePipelineLike | null = null;
    private computeBindGroupLayout: any = null;
    private resourcesByMesh = new WeakMap<MeshLike, MeshGpuResources>();
    private completedFrames = new Map<number, ProjectionFrameResult>();
    private waitersByFrame = new Map<number, Array<(ready: boolean) => void>>();
    private pendingRequest: GpuRequest | null = null;
    private inFlight = false;

    isSupported() {
        return typeof navigator !== 'undefined' && 'gpu' in navigator;
    }

    requestFrame(
        parts: ProjectionPartSource[],
        camera: THREE.Camera,
        viewportWidth: number,
        viewportHeight: number,
        frameId: number,
    ) {
        if (!this.isSupported() || viewportWidth <= 0 || viewportHeight <= 0 || parts.length === 0) {
            return;
        }

        const meshes = toUniqueMeshes(parts);
        if (meshes.length === 0) {
            return;
        }

        camera.updateMatrixWorld(true);
        const viewProjectionMatrix = new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );

        const meshSnapshots: MeshSnapshot[] = [];
        meshes.forEach((mesh) => {
                const partLeafIds = (
                    mesh.userData as {
                        partLeafIdByMaterialIndex?: string[];
                    }
                ).partLeafIdByMaterialIndex;
                if (!partLeafIds || partLeafIds.length === 0) {
                    return;
                }

                mesh.updateWorldMatrix(true, false);
                const bindMatrix = mesh instanceof THREE.SkinnedMesh ? mesh.bindMatrix : new THREE.Matrix4();
                const bindMatrixInverse =
                    mesh instanceof THREE.SkinnedMesh ? mesh.bindMatrixInverse : new THREE.Matrix4();

                if (mesh instanceof THREE.SkinnedMesh) {
                    mesh.skeleton.update();
                }

                if (partLeafIds.length === 0) {
                    return;
                }

                meshSnapshots.push({
                    mesh,
                    positions: toAnimatedLocalPositions(mesh),
                    matrixWorld: new Float32Array(flattenMatrix4(mesh.matrixWorld)),
                    bindMatrix: new Float32Array(flattenMatrix4(bindMatrix)),
                    bindMatrixInverse: new Float32Array(flattenMatrix4(bindMatrixInverse)),
                });
            });

        if (meshSnapshots.length === 0) {
            return;
        }

        if (this.pendingRequest) {
            this.resolveFrameWaiters(this.pendingRequest.frameId, false);
        }

        this.pendingRequest = {
            frameId,
            viewportWidth,
            viewportHeight,
            viewProjectionMatrix: new Float32Array(flattenMatrix4(viewProjectionMatrix)),
            meshSnapshots,
        };

        if (!this.inFlight) {
            void this.processRequests();
        }
    }

    async waitForFrame(frameId: number) {
        if (this.completedFrames.has(frameId)) {
            return true;
        }

        return await new Promise<boolean>((resolve) => {
            const waiters = this.waitersByFrame.get(frameId) ?? [];
            waiters.push(resolve);
            this.waitersByFrame.set(frameId, waiters);
        });
    }

    getFrame(frameId: number) {
        return this.completedFrames.get(frameId) ?? null;
    }

    private async processRequests() {
        if (this.inFlight) {
            return;
        }

        this.inFlight = true;
        while (this.pendingRequest) {
            const request = this.pendingRequest;
            this.pendingRequest = null;
            try {
                await this.runRequest(request);
            } catch (error) {
                console.warn('WebGPU projection frame failed. Falling back to CPU projection path.', error);
                this.resolveFrameWaiters(request.frameId, false);
            }
        }
        this.inFlight = false;
    }

    private async getDevice() {
        if (this.device) {
            return this.device;
        }

        if (!this.devicePromise) {
            this.devicePromise = (async () => {
                const device = await getSharedWebGpuContext().getDevice();
                if (!device) {
                    return null;
                }
                this.device = device;
                this.queue = device.queue;
                this.computePipeline = this.createComputePipeline(device);
                this.computeBindGroupLayout = this.computePipeline.getBindGroupLayout(0);
                return device;
            })();
        }

        return this.devicePromise;
    }

    private createComputePipeline(device: GPUDeviceLike) {
        return device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: device.createShaderModule({
                    code: `
struct Uniforms {
    modelMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,
    bindMatrix: mat4x4<f32>,
    bindMatrixInverse: mat4x4<f32>,
    viewport: vec2<f32>,
    vertexCount: u32,
    useSkinning: u32,
}

@group(0) @binding(0) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> projected: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let index = globalId.x;
    if (index >= uniforms.vertexCount) {
        return;
    }

    var localPosition = positions[index];
    let worldPosition = uniforms.modelMatrix * localPosition;
    let clipPosition = uniforms.viewProjectionMatrix * worldPosition;
    let ndc = clipPosition.xyz / clipPosition.www;
    let screenX = (ndc.x + 1.0) * 0.5 * uniforms.viewport.x;
    let screenY = (1.0 - ndc.y) * 0.5 * uniforms.viewport.y;
    projected[index] = vec4<f32>(screenX, screenY, ndc.z, clipPosition.w);
}
                    `,
                }),
                entryPoint: 'main',
            },
        });
    }

    private async runRequest(request: GpuRequest) {
        const device = await this.getDevice();
        if (!device || !this.queue || !this.computePipeline || !this.computeBindGroupLayout) {
            this.resolveFrameWaiters(request.frameId, false);
            return;
        }

        const commandEncoder = device.createCommandEncoder();
        const meshResources: Array<{ mesh: MeshLike; resource: MeshGpuResources; snapshot: MeshSnapshot }> = [];

        request.meshSnapshots.forEach((snapshot) => {
            const resource = this.ensureResources(device, snapshot);
            if (!resource) {
                return;
            }

            this.updateUniforms(
                device,
                resource.uniformsBuffer,
                snapshot,
                request.viewProjectionMatrix,
                request.viewportWidth,
                request.viewportHeight,
                resource.vertexCount,
            );
            device.queue.writeBuffer(resource.positionsBuffer, 0, snapshot.positions);
            meshResources.push({ mesh: snapshot.mesh, resource, snapshot });
        });

        if (meshResources.length === 0) {
            this.resolveFrameWaiters(request.frameId, false);
            return;
        }

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.computePipeline);
        meshResources.forEach(({ resource }) => {
            computePass.setBindGroup(0, resource.computeBindGroup);
            computePass.dispatchWorkgroups(Math.ceil(resource.vertexCount / WORKGROUP_SIZE));
        });
        computePass.end();

        meshResources.forEach(({ resource }) => {
            commandEncoder.copyBufferToBuffer(
                resource.projectedOutputBuffer,
                0,
                resource.projectedReadbackBuffer,
                0,
                resource.vertexCount * FLOATS_PER_PROJECTED_VERTEX * Float32Array.BYTES_PER_ELEMENT,
            );
        });

        this.queue.submit([commandEncoder.finish()]);

        const cachesByMesh = new WeakMap<MeshLike, MeshProjectionCache>();
        await Promise.all(
            meshResources.map(async ({ mesh, resource, snapshot }) => {
                await resource.projectedReadbackBuffer.mapAsync(1);
                const mapped = resource.projectedReadbackBuffer.getMappedRange();
                const copied = new Float32Array(mapped.slice(0));
                resource.projectedReadbackBuffer.unmap();
                cachesByMesh.set(
                    mesh,
                    this.unpackProjectionCache(
                        copied,
                        resource.vertexCount,
                        request.viewportWidth,
                        request.viewportHeight,
                        snapshot,
                    ),
                );
            }),
        );

        const result: ProjectionFrameResult = {
            frameId: request.frameId,
            width: request.viewportWidth,
            height: request.viewportHeight,
            getProjectionCache: (mesh) => cachesByMesh.get(mesh) ?? null,
        };
        this.completedFrames.set(request.frameId, result);
        [...this.completedFrames.keys()]
            .filter((frameId) => frameId < request.frameId - 3)
            .forEach((frameId) => {
                this.completedFrames.delete(frameId);
            });

        this.resolveFrameWaiters(request.frameId, true);
    }

    private ensureResources(device: GPUDeviceLike, snapshot: MeshSnapshot) {
        const geometry = snapshot.mesh.geometry;
        const positionAttribute = geometry.getAttribute('position');
        if (!positionAttribute) {
            return null;
        }

        const currentVersion = geometry.uuid;
        const existing = this.resourcesByMesh.get(snapshot.mesh);
        if (existing && existing.version === currentVersion) {
            return existing;
        }

        existing?.positionsBuffer.destroy();
        existing?.uniformsBuffer.destroy();
        existing?.projectedOutputBuffer.destroy();
        existing?.projectedReadbackBuffer.destroy();

        const vertexCount = positionAttribute.count;
        const positions = toVec4FloatArray(positionAttribute, 1);
        const positionsBuffer = this.createBuffer(device, positions, GPUBufferUsageStorage | GPUBufferUsageCopyDst);
        const uniformsBuffer = device.createBuffer({
            size: FLOATS_PER_UNIFORMS * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsageUniform | GPUBufferUsageCopyDst,
        });
        const projectedSize = vertexCount * FLOATS_PER_PROJECTED_VERTEX * Float32Array.BYTES_PER_ELEMENT;
        const projectedOutputBuffer = device.createBuffer({
            size: projectedSize,
            usage: GPUBufferUsageStorage | GPUBufferUsageCopySrc,
        });
        const projectedReadbackBuffer = device.createBuffer({
            size: projectedSize,
            usage: GPUBufferUsageMapRead | GPUBufferUsageCopyDst,
        });

        const computeBindGroup = device.createBindGroup({
            layout: this.computeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: positionsBuffer } },
                { binding: 1, resource: { buffer: projectedOutputBuffer } },
                { binding: 2, resource: { buffer: uniformsBuffer } },
            ],
        });

        const resource: MeshGpuResources = {
            version: currentVersion,
            vertexCount,
            positionsBuffer,
            uniformsBuffer,
            projectedOutputBuffer,
            projectedReadbackBuffer,
            computeBindGroup,
        };
        this.resourcesByMesh.set(snapshot.mesh, resource);
        return resource;
    }

    private createBuffer(device: GPUDeviceLike, data: Float32Array | Uint32Array, usage: number) {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage,
            mappedAtCreation: true,
        });
        const mapped = buffer.getMappedRange();
        if (data instanceof Float32Array) {
            new Float32Array(mapped).set(data);
        } else {
            new Uint32Array(mapped).set(data);
        }
        buffer.unmap();
        return buffer;
    }

    private updateUniforms(
        device: GPUDeviceLike,
        uniformsBuffer: GPUBufferLike,
        snapshot: MeshSnapshot,
        viewProjectionMatrix: Float32Array,
        viewportWidth: number,
        viewportHeight: number,
        vertexCount: number,
    ) {
        const uniforms = new Float32Array(FLOATS_PER_UNIFORMS);
        uniforms.set(snapshot.matrixWorld, 0);
        uniforms.set(viewProjectionMatrix, 16);
        uniforms.set(snapshot.bindMatrix, 32);
        uniforms.set(snapshot.bindMatrixInverse, 48);
        uniforms[64] = viewportWidth;
        uniforms[65] = viewportHeight;
        uniforms[66] = vertexCount;
        uniforms[67] = 0;
        device.queue.writeBuffer(uniformsBuffer, 0, uniforms);
    }

    private resolveFrameWaiters(frameId: number, ready: boolean) {
        const waiters = this.waitersByFrame.get(frameId);
        if (!waiters) {
            return;
        }
        waiters.forEach((resolve) => resolve(ready));
        this.waitersByFrame.delete(frameId);
    }

    private unpackProjectionCache(
        data: Float32Array,
        vertexCount: number,
        viewportWidth: number,
        viewportHeight: number,
        snapshot: MeshSnapshot,
    ): MeshProjectionCache {
        const screenX = new Float32Array(vertexCount);
        const screenY = new Float32Array(vertexCount);
        const depth = new Float32Array(vertexCount);
        const worldX = new Float32Array(vertexCount);
        const worldY = new Float32Array(vertexCount);
        const worldZ = new Float32Array(vertexCount);
        const worldMatrix = new THREE.Matrix4().fromArray(snapshot.matrixWorld);
        const worldPosition = new THREE.Vector3();

        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
            const offset = vertexIndex * FLOATS_PER_PROJECTED_VERTEX;
            screenX[vertexIndex] = data[offset];
            screenY[vertexIndex] = data[offset + 1];
            depth[vertexIndex] = data[offset + 2];
            worldPosition.set(
                snapshot.positions[offset],
                snapshot.positions[offset + 1],
                snapshot.positions[offset + 2],
            ).applyMatrix4(worldMatrix);
            worldX[vertexIndex] = worldPosition.x;
            worldY[vertexIndex] = worldPosition.y;
            worldZ[vertexIndex] = worldPosition.z;
        }

        return {
            width: viewportWidth,
            height: viewportHeight,
            screenX,
            screenY,
            depth,
            worldX,
            worldY,
            worldZ,
        };
    }
}

let pipeline: WebGpuProjectionPipeline | null = null;

export const getWebGpuScreenProjector = () => {
    pipeline ??= new WebGpuProjectionPipeline();
    return pipeline;
};
