import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { toAnimatedLocalPositions } from './projector';

describe('animated projection positions', () => {
    it('includes morph target influence in projected vertex snapshots', () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute([0, 0, 0], 3),
        );
        geometry.morphAttributes.position = [
            new THREE.Float32BufferAttribute([0.25, 0.5, 0], 3),
        ];
        geometry.morphTargetsRelative = true;
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        mesh.morphTargetInfluences = [0.8];

        const positions = toAnimatedLocalPositions(mesh);

        expect(positions[0]).toBeCloseTo(0.2);
        expect(positions[1]).toBeCloseTo(0.4);
        expect(positions[2]).toBeCloseTo(0);
    });

    it('applies morph targets before skinning for skinned meshes', () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute([0, 0, 0], 3),
        );
        geometry.setAttribute(
            'skinIndex',
            new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4),
        );
        geometry.setAttribute(
            'skinWeight',
            new THREE.Float32BufferAttribute([1, 0, 0, 0], 4),
        );
        geometry.morphAttributes.position = [
            new THREE.Float32BufferAttribute([1, 0, 0], 3),
        ];
        geometry.morphTargetsRelative = true;
        const bone = new THREE.Bone();
        bone.position.x = 2;
        const skeleton = new THREE.Skeleton([bone]);
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
        mesh.add(bone);
        mesh.bind(skeleton);
        mesh.morphTargetInfluences = [1];
        mesh.updateMatrixWorld(true);
        skeleton.update();

        const positions = toAnimatedLocalPositions(mesh);

        expect(positions[0]).toBeCloseTo(1);
    });
});
