import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeFaceParams, type BakeProjector } from './bake';
import type { ProjectionPartSource, ProjectionTriangleSource } from '../modelParts';
import type { MeshProjectionCache } from '../2DRenderShared/types';

const triangle = (a: number, b: number, c: number): ProjectionTriangleSource => ({
    vertexIndices: [a, b, c],
    vertexPositionKeys: [`${a}`, `${b}`, `${c}`],
});

const buildFixture = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));

    const root = new THREE.Object3D();
    const head = new THREE.Bone();
    head.name = '頭';
    root.add(head);
    root.updateMatrixWorld(true);

    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([head]));
    mesh.morphTargetDictionary = { ウィンク: 0, 'ウィンク右': 1, あ: 2 };
    mesh.morphTargetInfluences = [0, 0, 0];

    const parts: ProjectionPartSource[] = [
        {
            leafId: 'face',
            label: 'face',
            materialNames: ['skin'],
            parentPath: 'model',
            mesh,
            triangleCount: 1,
            color: '#ff0000',
            triangles: [triangle(0, 1, 2)],
        },
        {
            leafId: 'hair',
            label: 'hair',
            materialNames: ['hair'],
            parentPath: 'model',
            mesh,
            triangleCount: 1,
            color: '#00ff00',
            triangles: [triangle(3, 4, 5)],
        },
    ];

    return { root, mesh, head, parts };
};

const buildFakeProjector = (options: { failFirstAttempts?: number } = {}): BakeProjector & {
    requestLog: number[];
} => {
    const { failFirstAttempts = 0 } = options;
    const requestLog: number[] = [];
    let attemptCount = 0;

    return {
        requestLog,
        isSupported: () => true,
        requestFrame: (_parts, _camera, width, height, frameId) => {
            requestLog.push(frameId);
            void width;
            void height;
        },
        waitForFrame: async (frameId) => {
            attemptCount += 1;
            if (attemptCount <= failFirstAttempts) {
                return false;
            }
            return requestLog.includes(frameId);
        },
        getFrame: (frameId) => {
            if (!requestLog.includes(frameId)) {
                return null;
            }
            const caches = new Map<THREE.Object3D, MeshProjectionCache>();
            return {
                getProjectionCache: (mesh) => {
                    let cache = caches.get(mesh);
                    if (!cache) {
                        const count = mesh.geometry.getAttribute('position').count;
                        cache = {
                            width: 1024,
                            height: 1024,
                            screenX: Float32Array.from({ length: count }, (_, i) => frameId + i),
                            screenY: Float32Array.from({ length: count }, (_, i) => -i),
                            depth: Float32Array.from({ length: count }, () => 0.5),
                            worldX: new Float32Array(count),
                            worldY: new Float32Array(count),
                            worldZ: new Float32Array(count),
                        };
                        caches.set(mesh, cache);
                    }
                    return cache;
                },
            };
        },
    };
};

describe('bakeFaceParams orchestration', () => {
    it('captures one vertex sample per plan entry and restores the pose', async () => {
        const { root, mesh, head, parts } = buildFixture();
        head.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.2);
        root.updateMatrixWorld(true);
        const preBakeQuat = head.quaternion.clone();
        const projector = buildFakeProjector();

        const progress: Array<{ done: number; total: number }> = [];
        const bundle = await bakeFaceParams({
            root,
            parts,
            camera: new THREE.PerspectiveCamera(30, 1, 0.1, 100),
            projector,
            modelName: 'test-model',
            comboCount: 4,
            onProgress: (done, total) => progress.push({ done, total }),
        });

        // 1 neutral + 3 angle sweeps (13) + 3 morph sweeps (9) + 4 combos
        expect(bundle.samples).toHaveLength(1 + 13 * 3 + 9 * 3 + 4);
        expect(bundle.samples[0].kind).toBe('neutral');
        expect(bundle.samples[1].kind).toBe('family-sweep');
        expect(bundle.samples[1].family).toBe('ParamAngleX');
        expect(bundle.samples.at(-1)!.kind).toBe('combo-qa');

        expect(bundle.parts).toHaveLength(2);
        expect(bundle.parts[0].triangles).toEqual([[0, 1, 2]]);

        // Each sample carries its own frame's projected data.
        const firstVertex = bundle.samples[0].meshes[0].vertices.screenX[0];
        bundle.samples.forEach((sample, index) => {
            expect(sample.meshes[0].vertices.screenX[0] - firstVertex).toBe(index);
        });

        expect(bundle.params.filter((param) => param.resolved)).toHaveLength(6);
        expect(head.quaternion.angleTo(preBakeQuat)).toBeLessThan(1e-6);
        expect(mesh.morphTargetInfluences).toEqual([0, 0, 0]);

        expect(progress).toHaveLength(bundle.samples.length);
        expect(progress.at(-1)).toEqual({ done: bundle.samples.length, total: bundle.samples.length });
    });

    it('retries a sample when the first projection wait resolves false', async () => {
        const { root, parts } = buildFixture();
        const projector = buildFakeProjector({ failFirstAttempts: 1 });

        const bundle = await bakeFaceParams({
            root,
            parts,
            camera: new THREE.PerspectiveCamera(30, 1, 0.1, 100),
            projector,
            modelName: 'test-model',
            comboCount: 0,
        });

        // First wait resolves false; the retried request must still land data.
        expect(bundle.samples).toHaveLength(1 + 13 * 3 + 9 * 3);
        expect(bundle.samples[0].meshes[0].vertices.screenX.length).toBe(8);
        expect(projector.requestLog.length).toBeGreaterThanOrEqual(bundle.samples.length);
    });

    it('throws when WebGPU projection is unavailable', async () => {
        const { root, parts } = buildFixture();
        const projector = buildFakeProjector();
        await expect(
            bakeFaceParams({
                root,
                parts,
                camera: new THREE.PerspectiveCamera(30, 1, 0.1, 100),
                projector: { ...projector, isSupported: () => false },
                modelName: 'test-model',
            }),
        ).rejects.toThrow('WebGPU projection is not available');
    });
});
