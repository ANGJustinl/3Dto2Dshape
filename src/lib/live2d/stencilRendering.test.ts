import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { renderMaskedMeshes } from './stencilRendering';

describe('stencil preview rendering', () => {
    it('preserves scene children, order, textures and color across repeated frames', () => {
        const scene = new THREE.Scene();
        const meshes = Array.from({ length: 3 }, () => new THREE.Mesh(
            new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
        ));
        scene.add(...meshes);
        const write = meshes[0].material.clone();
        write.colorWrite = false;
        const groups = [{ maskerMesh: meshes[0], maskedMeshes: meshes.slice(1), stencilWriteMaterial: write }];
        const seen: THREE.Material[] = [];
        const renderer = {
            autoClear: true, clear: vi.fn(), clearStencil: vi.fn(),
            render: vi.fn((mesh: THREE.Object3D) => {
                expect(renderer.autoClear).toBe(false);
                seen.push((mesh as THREE.Mesh).material as THREE.Material);
            }),
        };
        for (let frame = 0; frame < 2; frame++) {
            renderMaskedMeshes(renderer, new THREE.Camera(), meshes, groups);
            expect(scene.children).toEqual(meshes);
            expect(renderer.autoClear).toBe(true);
            expect(meshes[1].material.stencilWrite).toBe(false);
        }
        expect(seen.slice(0, 5)).toEqual([meshes[0].material, write, meshes[1].material, write, meshes[2].material]);
        expect(renderer.clear).toHaveBeenCalledTimes(2);
        expect(renderer.clearStencil).toHaveBeenCalledTimes(4);
    });

    it('restores renderer and mask material when a render fails', () => {
        const masker = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
        const target = masker.clone();
        const original = masker.material;
        const renderer = { autoClear: true, clear: vi.fn(), clearStencil: vi.fn(), render: () => { throw new Error('context lost'); } };
        expect(() => renderMaskedMeshes(renderer, new THREE.Camera(), [target], [{
            maskerMesh: masker, maskedMeshes: [target], stencilWriteMaterial: original.clone(),
        }])).toThrow('context lost');
        expect(masker.material).toBe(original);
        expect(renderer.autoClear).toBe(true);
    });
});
