import * as THREE from 'three';
import type { MeshProjectionCache } from '../2DRenderShared/types';
import type { ProjectionPartSource } from '../modelParts';
import { resolveFaceParams } from './paramMapping';
import { FacePoseDriver } from './poseDriver';
import { buildSamplePlan } from './sampling';
import type { BakeBundle, BakeMeshSample, BakePartSnapshot, BakeSample, ResolvedFaceParam } from './types';

/**
 * Bake orchestrator (M0): drives the WebGPU projector through the face
 * parameter sampling plan and collects per-mesh projected vertex buffers.
 *
 * The projector dependency is an interface so tests can substitute a fake;
 * the real one is getWebGpuScreenProjector(). Frame IDs live far above the
 * animate loop's counter so the two never collide; if the animate loop does
 * manage to supersede a bake request (window resize, control damping), the
 * sample is retried a bounded number of times.
 */
export type BakeProjector = {
    isSupported(): boolean;
    requestFrame(
        parts: ProjectionPartSource[],
        camera: THREE.Camera,
        viewportWidth: number,
        viewportHeight: number,
        frameId: number,
    ): void;
    waitForFrame(frameId: number): Promise<boolean>;
    getFrame(frameId: number): {
        getProjectionCache: (mesh: THREE.Mesh | THREE.SkinnedMesh) => MeshProjectionCache | null;
    } | null;
};

const BAKE_FRAME_ID_BASE = 1_000_000;
export const DEFAULT_BAKE_VIEWPORT = { width: 1024, height: 1024 };
const FRAME_TIMEOUT_MS = 10_000;
const MAX_SAMPLE_RETRIES = 2;

export type BakeOptions = {
    root: THREE.Object3D;
    parts: ProjectionPartSource[];
    camera: THREE.PerspectiveCamera;
    projector: BakeProjector;
    modelName: string;
    viewport?: { width: number; height: number };
    comboCount?: number;
    seed?: number;
    onProgress?: (done: number, total: number, entryId: string) => void;
};

const waitForFrameWithTimeout = async (projector: BakeProjector, frameId: number) => {
    return await Promise.race([
        projector.waitForFrame(frameId),
        new Promise<boolean>((_, reject) => {
            globalThis.setTimeout(
                () => reject(new Error(`Projection frame ${frameId} timed out.`)),
                FRAME_TIMEOUT_MS,
            );
        }),
    ]);
};

export const bakePartsFromSources = (parts: ProjectionPartSource[]): BakePartSnapshot[] =>
    parts.map((part) => ({
        leafId: part.leafId,
        label: part.label,
        meshId: part.mesh.uuid,
        color: part.color,
        triangleCount: part.triangleCount,
        triangles: part.triangles.map((triangle) => [...triangle.vertexIndices] as [number, number, number]),
    }));

export type BakeTargets = {
    mesh: THREE.SkinnedMesh;
    params: ResolvedFaceParam[];
    definitions: ResolvedFaceParam[];
};

export const resolveBakeTargets = (parts: ProjectionPartSource[]) => {
    const meshes = [...new Set(parts.map((part) => part.mesh))];
    const resolution = resolveFaceParams(meshes);
    const resolvedDefinitions = resolution.params.filter((param) => param.resolved !== null);
    return { meshes, resolution, resolvedDefinitions };
};

export type CollectSamplesArgs = {
    root: THREE.Object3D;
    parts: ProjectionPartSource[];
    camera: THREE.PerspectiveCamera;
    projector: BakeProjector;
    viewport: { width: number; height: number };
    comboCount: number;
    seed?: number;
    definitions: BakeTargets['definitions'];
    params: BakeTargets['params'];
    mesh: THREE.SkinnedMesh;
    meshes: Array<THREE.Mesh | THREE.SkinnedMesh>;
    onProgress?: (done: number, total: number, entryId: string) => void;
    /**
     * Runs while the pose driver still holds the neutral pose, before the
     * pre-bake snapshot is restored — used to render isolated textures with
     * the exact camera/viewport the samples were projected with.
     */
    onNeutral?: (camera: THREE.PerspectiveCamera, samples: BakeSample[]) => void | Promise<void>;
};

export const collectBakeSamples = async (args: CollectSamplesArgs): Promise<BakeSample[]> => {
    const {
        root,
        parts,
        camera,
        projector,
        viewport,
        comboCount,
        seed,
        definitions,
        params,
        mesh,
        meshes,
        onProgress,
        onNeutral,
    } = args;

    const bakeCamera = camera.clone();
    bakeCamera.aspect = viewport.width / viewport.height;
    bakeCamera.updateProjectionMatrix();

    const plan = buildSamplePlan(definitions, { comboCount, seed });
    const driver = new FacePoseDriver(mesh, params, root);
    const snapshot = driver.snapshot();
    driver.applyNeutral();

    const samples: BakeSample[] = [];
    try {
        for (let planIndex = 0; planIndex < plan.length; planIndex += 1) {
            const entry = plan[planIndex];
            driver.applyAssignment(entry.assignment);

            let meshSamples: BakeMeshSample[] | null = null;
            for (let attempt = 0; attempt <= MAX_SAMPLE_RETRIES; attempt += 1) {
                const frameId = BAKE_FRAME_ID_BASE + planIndex;
                projector.requestFrame(parts, bakeCamera, viewport.width, viewport.height, frameId);
                // eslint-disable-next-line no-await-in-loop -- retries must be sequential
                const ready = await waitForFrameWithTimeout(projector, frameId);
                if (!ready) {
                    continue;
                }
                const frame = projector.getFrame(frameId);
                if (!frame) {
                    continue;
                }

                meshSamples = meshes
                    .map((partMesh): BakeMeshSample | null => {
                        const cache = frame.getProjectionCache(partMesh);
                        if (!cache) {
                            return null;
                        }
                        return {
                            meshId: partMesh.uuid,
                            vertices: {
                                screenX: cache.screenX,
                                screenY: cache.screenY,
                                depth: cache.depth,
                            },
                        };
                    })
                    .filter((sample): sample is BakeMeshSample => sample !== null);
                break;
            }

            if (!meshSamples) {
                throw new Error(`Failed to capture projection for sample ${entry.id}.`);
            }

            samples.push({
                id: entry.id,
                kind: entry.kind,
                family: entry.family,
                index: entry.index,
                assignment: entry.assignment,
                viewport: { ...viewport },
                meshes: meshSamples,
            });
            onProgress?.(planIndex + 1, plan.length, entry.id);
        }

        // Back to neutral so onNeutral callbacks (texture renders) see exactly
        // the pose the neutral sample was captured in.
        driver.applyAssignment(
            definitions.reduce(
                (assignment, definition) => {
                    assignment[definition.id] = definition.default;
                    return assignment;
                },
                {} as BakeSample['assignment'],
            ),
        );
        await onNeutral?.(bakeCamera, samples);
    } finally {
        driver.restore(snapshot);
    }

    return samples;
};

export const bakeFaceParams = async (options: BakeOptions): Promise<BakeBundle> => {
    const {
        root,
        parts,
        camera,
        projector,
        modelName,
        viewport = DEFAULT_BAKE_VIEWPORT,
        comboCount = 100,
        seed,
        onProgress,
    } = options;

    if (!projector.isSupported()) {
        throw new Error('WebGPU projection is not available; face bake requires it.');
    }

    const { meshes, resolution, resolvedDefinitions } = resolveBakeTargets(parts);
    if (!resolution.mesh) {
        throw new Error('No skinned mesh found; face bake requires a skeleton.');
    }
    if (resolvedDefinitions.length === 0) {
        throw new Error('No face parameters resolved (no head bone and no face morphs found).');
    }

    const samples = await collectBakeSamples({
        root,
        parts,
        camera,
        projector,
        viewport,
        comboCount,
        seed,
        definitions: resolvedDefinitions,
        params: resolution.params,
        mesh: resolution.mesh,
        meshes,
        onProgress,
    });

    return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        modelName,
        params: resolution.params,
        parts: bakePartsFromSources(parts),
        samples,
    };
};
