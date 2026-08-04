import * as THREE from 'three';
import type { ProjectionPartSource } from './modelParts';
import type { MeshProjectionCache } from './partProjection';

export type GpuRasterizedPartData = {
    occupied: Uint8Array;
    depthField: {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        values: Float32Array;
    };
    nearestDepth: number;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
};

type PartGeometryResource = {
    geometry: THREE.BufferGeometry;
    positionAttribute: THREE.BufferAttribute;
    sourceVertexIndices: Int32Array;
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
    resource: PartGeometryResource;
    atlasX: number;
    atlasY: number;
};

const DEPTH_PACK_EPSILON = 1 / 16777216;
const ATLAS_PADDING = 1;

const unpackDepthFromRgba = (red: number, green: number, blue: number, alpha: number) => {
    const normalizedRed = red / 255;
    const normalizedGreen = green / 255;
    const normalizedBlue = blue / 255;
    const normalizedAlpha = alpha / 255;
    return (
        normalizedRed / (256 * 256 * 256) +
        normalizedGreen / (256 * 256) +
        normalizedBlue / 256 +
        normalizedAlpha
    );
};

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

const fillDenseDepthField = (
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    occupied: Uint8Array,
    sparseDepth: Float32Array,
    fallbackDepth: number,
) => {
    const denseValues = new Float32Array(sparseDepth);
    const valid = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    for (let index = 0; index < occupied.length; index += 1) {
        if (occupied[index] === 1) {
            valid[index] = 1;
            queue[tail] = index;
            tail += 1;
        }
    }

    if (tail === 0) {
        denseValues.fill(fallbackDepth);
        return {
            width,
            height,
            offsetX,
            offsetY,
            values: denseValues,
        };
    }

    while (head < tail) {
        const current = queue[head];
        head += 1;
        const x = current % width;
        const y = Math.floor(current / width);
        const neighbors: Array<[number, number]> = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
        ];

        neighbors.forEach(([neighborX, neighborY]) => {
            if (neighborX < 0 || neighborY < 0 || neighborX >= width || neighborY >= height) {
                return;
            }

            const neighborIndex = neighborY * width + neighborX;
            if (valid[neighborIndex] === 1) {
                return;
            }

            valid[neighborIndex] = 1;
            denseValues[neighborIndex] = denseValues[current];
            queue[tail] = neighborIndex;
            tail += 1;
        });
    }

    return {
        width,
        height,
        offsetX,
        offsetY,
        values: denseValues,
    };
};

class GpuPartRasterizer {
    private scene = new THREE.Scene();
    private camera = new THREE.Camera();
    private target = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: true,
        stencilBuffer: false,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
    });
    private mesh: THREE.Mesh;
    private resourcesByLeafId = new Map<string, PartGeometryResource>();
    private pixelBuffer = new Uint8Array(4);

    constructor() {
        const material = new THREE.ShaderMaterial({
            depthTest: true,
            depthWrite: true,
            transparent: false,
            blending: THREE.NoBlending,
            toneMapped: false,
            dithering: false,
            vertexShader: `
precision highp float;
precision highp int;

varying float vPackedDepth;

void main() {
    gl_Position = vec4(position, 1.0);
    vPackedDepth = clamp(position.z * 0.5 + 0.5, ${DEPTH_PACK_EPSILON.toFixed(12)}, 1.0);
}
            `,
            fragmentShader: `
precision highp float;
precision highp int;

varying float vPackedDepth;

vec4 packDepthToRGBA(const in float value) {
    vec4 bitShift = vec4(
        256.0 * 256.0 * 256.0,
        256.0 * 256.0,
        256.0,
        1.0
    );
    vec4 bitMask = vec4(
        0.0,
        1.0 / 256.0,
        1.0 / 256.0,
        1.0 / 256.0
    );
    vec4 packed = fract(value * bitShift);
    packed -= packed.xxyz * bitMask;
    return packed;
}

void main() {
    gl_FragColor = packDepthToRGBA(vPackedDepth);
}
            `,
        });
        this.target.texture.colorSpace = THREE.NoColorSpace;
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.updateMatrix();
        this.scene.add(this.mesh);
    }

    dispose() {
        this.target.dispose();
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
        this.resourcesByLeafId.forEach((resource) => {
            resource.geometry.dispose();
        });
        this.resourcesByLeafId.clear();
    }

    rasterizeBatch(renderer: THREE.WebGLRenderer, requests: RasterizeRequest[]) {
        const preparedRequests = this.prepareRequests(renderer, requests);
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

        if (this.target.width !== atlasWidth || this.target.height !== atlasHeight) {
            this.target.setSize(atlasWidth, atlasHeight);
        }

        const pixelCount = atlasWidth * atlasHeight * 4;
        if (this.pixelBuffer.length !== pixelCount) {
            this.pixelBuffer = new Uint8Array(pixelCount);
        }

        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        const previousScissorTest = renderer.getScissorTest();
        const previousViewport = new THREE.Vector4();
        const previousScissor = new THREE.Vector4();
        const previousClearColor = new THREE.Color();
        renderer.getViewport(previousViewport);
        renderer.getScissor(previousScissor);
        renderer.getClearColor(previousClearColor);
        const previousClearAlpha = renderer.getClearAlpha();

        renderer.autoClear = false;
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.setScissorTest(false);
        renderer.clear(true, true, true);
        renderer.setScissorTest(true);

        preparedRequests.forEach((request) => {
            renderer.setViewport(request.atlasX, request.atlasY, request.bounds.width, request.bounds.height);
            renderer.setScissor(request.atlasX, request.atlasY, request.bounds.width, request.bounds.height);
            this.mesh.geometry = request.resource.geometry;
            renderer.render(this.scene, this.camera);
        });

        renderer.readRenderTargetPixels(this.target, 0, 0, atlasWidth, atlasHeight, this.pixelBuffer);

        renderer.setRenderTarget(previousTarget);
        renderer.setViewport(previousViewport);
        renderer.setScissor(previousScissor);
        renderer.setScissorTest(previousScissorTest);
        renderer.setClearColor(previousClearColor, previousClearAlpha);
        renderer.autoClear = previousAutoClear;

        return requests.map((request) => {
            const preparedRequest = preparedRequests.find((candidate) => candidate.part.leafId === request.part.leafId);
            if (!preparedRequest) {
                return null;
            }
            return this.extractRasterizedData(atlasWidth, atlasHeight, preparedRequest);
        });
    }

    private prepareRequests(renderer: THREE.WebGLRenderer, requests: RasterizeRequest[]) {
        const maxTextureSize = renderer.capabilities.maxTextureSize;
        const atlasMaxWidth = Math.max(256, Math.min(2048, maxTextureSize));
        const preparedRequests: PreparedRequest[] = [];
        let cursorX = 0;
        let cursorY = 0;
        let rowHeight = 0;

        requests.forEach((request) => {
            const bounds = computePartBounds(request.part, request.projectionCache);
            if (!bounds) {
                return;
            }

            const resource = this.ensureResource(request.part);
            this.updatePositions(resource, request.projectionCache, bounds);

            if (cursorX > 0 && cursorX + bounds.width > atlasMaxWidth) {
                cursorX = 0;
                cursorY += rowHeight + ATLAS_PADDING;
                rowHeight = 0;
            }

            preparedRequests.push({
                ...request,
                bounds,
                resource,
                atlasX: cursorX,
                atlasY: cursorY,
            });

            cursorX += bounds.width + ATLAS_PADDING;
            rowHeight = Math.max(rowHeight, bounds.height);
        });

        return preparedRequests;
    }

    private extractRasterizedData(
        atlasWidth: number,
        atlasHeight: number,
        request: PreparedRequest,
    ): GpuRasterizedPartData {
        const { bounds, fallbackDepth, atlasX, atlasY } = request;
        const occupied = new Uint8Array(bounds.width * bounds.height);
        const sparseDepth = new Float32Array(bounds.width * bounds.height);
        sparseDepth.fill(fallbackDepth);
        let nearestDepth = Number.POSITIVE_INFINITY;

        for (let localY = 0; localY < bounds.height; localY += 1) {
            const atlasRow = atlasY + (bounds.height - 1 - localY);
            for (let localX = 0; localX < bounds.width; localX += 1) {
                const sourceOffset = (atlasRow * atlasWidth + (atlasX + localX)) * 4;
                const red = this.pixelBuffer[sourceOffset];
                const green = this.pixelBuffer[sourceOffset + 1];
                const blue = this.pixelBuffer[sourceOffset + 2];
                const alpha = this.pixelBuffer[sourceOffset + 3];
                const hasCoverage = red !== 0 || green !== 0 || blue !== 0 || alpha !== 0;
                if (!hasCoverage) {
                    continue;
                }

                const depth01 = unpackDepthFromRgba(red, green, blue, alpha);
                const ndcDepth = depth01 * 2 - 1;
                const pixelIndex = localY * bounds.width + localX;
                occupied[pixelIndex] = 1;
                sparseDepth[pixelIndex] = ndcDepth;
                if (ndcDepth < nearestDepth) {
                    nearestDepth = ndcDepth;
                }
            }
        }

        const depthField = fillDenseDepthField(
            bounds.width,
            bounds.height,
            bounds.offsetX,
            bounds.offsetY,
            occupied,
            sparseDepth,
            fallbackDepth,
        );

        return {
            occupied,
            depthField,
            nearestDepth,
            width: bounds.width,
            height: bounds.height,
            offsetX: bounds.offsetX,
            offsetY: bounds.offsetY,
        };
    }

    private ensureResource(part: ProjectionPartSource) {
        const existing = this.resourcesByLeafId.get(part.leafId);
        const vertexCount = part.triangles.length * 3;
        if (existing && existing.positionAttribute.count === vertexCount) {
            return existing;
        }

        existing?.geometry.dispose();

        const positions = new Float32Array(vertexCount * 3);
        const sourceVertexIndices = new Int32Array(vertexCount);
        part.triangles.forEach((triangle, triangleIndex) => {
            triangle.vertexIndices.forEach((vertexIndex, cornerIndex) => {
                sourceVertexIndices[triangleIndex * 3 + cornerIndex] = vertexIndex;
            });
        });

        const geometry = new THREE.BufferGeometry();
        const positionAttribute = new THREE.BufferAttribute(positions, 3);
        geometry.setAttribute('position', positionAttribute);

        const resource = {
            geometry,
            positionAttribute,
            sourceVertexIndices,
        };
        this.resourcesByLeafId.set(part.leafId, resource);
        return resource;
    }

    private updatePositions(
        resource: PartGeometryResource,
        projectionCache: MeshProjectionCache,
        bounds: PartBounds,
    ) {
        for (let index = 0; index < resource.sourceVertexIndices.length; index += 1) {
            const sourceVertexIndex = resource.sourceVertexIndices[index];
            const screenX = projectionCache.screenX[sourceVertexIndex];
            const screenY = projectionCache.screenY[sourceVertexIndex];
            const depth = projectionCache.depth[sourceVertexIndex];
            const localX = (screenX - bounds.offsetX) / bounds.width;
            const localY = (screenY - bounds.offsetY) / bounds.height;
            resource.positionAttribute.setXYZ(
                index,
                localX * 2 - 1,
                1 - localY * 2,
                depth,
            );
        }
        resource.positionAttribute.needsUpdate = true;
    }
}

let rasterizer: GpuPartRasterizer | null = null;

export const getGpuPartRasterizer = () => {
    rasterizer ??= new GpuPartRasterizer();
    return rasterizer;
};
