import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FACE_PARAM_DEFINITIONS, resolveFaceParams } from './paramMapping';
import { defaultAssignment } from './paramMapping';
import { FacePoseDriver } from './poseDriver';
import type { ResolvedFaceParam } from './types';

const buildSkinnedMesh = (options: {
    boneNames?: string[];
    morphNames?: string[];
    preRotate?: boolean;
} = {}) => {
    const { boneNames = ['頭'], morphNames = [], preRotate = false } = options;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));

    const root = new THREE.Object3D();
    const bones = boneNames.map((name) => {
        const bone = new THREE.Bone();
        bone.name = name;
        return bone;
    });
    bones.forEach((bone, index) => {
        if (index === 0) {
            root.add(bone);
        } else {
            bones[index - 1].add(bone);
        }
    });
    if (preRotate) {
        bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    }
    root.updateMatrixWorld(true);

    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton(bones));
    if (morphNames.length > 0) {
        mesh.morphTargetDictionary = Object.fromEntries(
            morphNames.map((name, index) => [name, index]),
        );
        mesh.morphTargetInfluences = morphNames.map(() => 0);
    }
    return { root, mesh, bones };
};

const resolvedParamsWith = (meshId: string, overrides: Partial<Record<string, unknown>> = {}): ResolvedFaceParam[] =>
    FACE_PARAM_DEFINITIONS.map((definition) => {
        const resolved =
            definition.source.kind === 'boneRotation'
                ? { meshId, boneName: overrides[definition.id] ?? definition.source.boneNames[0] }
                : {
                      meshId,
                      morphIndex: overrides[definition.id] ?? 0,
                  };
        return { ...definition, resolved } as ResolvedFaceParam;
    });

describe('face param resolution', () => {
    it('binds head bones and morphs with fallback chains', () => {
        const { mesh } = buildSkinnedMesh({
            boneNames: ['頭', '首'],
            morphNames: ['まばたき', 'あ'],
        });
        mesh.uuid = 'mesh-1';
        const { params } = resolveFaceParams([mesh]);

        const angleX = params.find((param) => param.id === 'ParamAngleX');
        expect(angleX?.resolved?.boneName).toBe('頭');
        expect(angleX?.resolved?.fallbackUsed).toBe(false);

        const eyeLeft = params.find((param) => param.id === 'ParamEyeLOpen');
        expect(eyeLeft?.resolved?.morphIndex).toBe(0);
        expect(eyeLeft?.resolved?.fallbackUsed).toBe(true);

        const mouth = params.find((param) => param.id === 'ParamMouthOpenY');
        expect(mouth?.resolved?.morphIndex).toBe(1);
    });

    it('resolves to null when the model has neither head bone nor morphs', () => {
        const { mesh } = buildSkinnedMesh({ boneNames: ['全ての親'] });
        const { params, mesh: resolvedMesh } = resolveFaceParams([mesh]);
        expect(resolvedMesh).not.toBeNull();
        params.forEach((param) => expect(param.resolved).toBeNull());
    });

    it('prefers the mesh that resolves more params', () => {
        const { mesh: faceMesh } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'] });
        const { mesh: bodyMesh } = buildSkinnedMesh({ boneNames: ['全ての親'] });
        const { params, mesh } = resolveFaceParams([bodyMesh, faceMesh]);
        expect(mesh).toBe(faceMesh);
        expect(params.filter((param) => param.resolved)).toHaveLength(4);
    });
});

describe('FacePoseDriver', () => {
    it('composes yaw on top of the neutral bone rotation', () => {
        const { root, mesh, bones } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'], preRotate: true });
        const head = bones[0];
        const neutralQuat = head.quaternion.clone();

        const driver = new FacePoseDriver(mesh, resolvedParamsWith(mesh.uuid), root);
        driver.applyNeutral();
        const assignment = defaultAssignment();
        assignment.ParamAngleX = 30;
        driver.applyAssignment(assignment);

        const expected = neutralQuat
            .clone()
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(30)));
        expect(head.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    });

    it('applies angle families sharing one bone in X-then-Z order', () => {
        const { root, mesh, bones } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'] });
        const head = bones[0];

        const driver = new FacePoseDriver(mesh, resolvedParamsWith(mesh.uuid), root);
        driver.applyNeutral();
        const assignment = defaultAssignment();
        assignment.ParamAngleX = 20;
        assignment.ParamAngleZ = 10;
        driver.applyAssignment(assignment);

        const rotationX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(20));
        const rotationZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(10));
        expect(head.quaternion.angleTo(rotationX.clone().multiply(rotationZ))).toBeLessThan(1e-6);
    });

    it('maps the full pitch parameter range to a gentler physical head rotation', () => {
        const { root, mesh, bones } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'] });
        const head = bones[0];
        const driver = new FacePoseDriver(mesh, resolvedParamsWith(mesh.uuid), root);
        driver.applyNeutral();
        const assignment = defaultAssignment();
        // Live2D convention: positive pitch = head tilts UP, which is a
        // NEGATIVE X bone rotation.
        assignment.ParamAngleY = 30;
        driver.applyAssignment(assignment);

        const expected = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0),
            THREE.MathUtils.degToRad(-19.5),
        );
        expect(head.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    });

    it('maps morph params through direct and inverse value maps', () => {
        const { root, mesh } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['ウィンク', 'ウィンク右', 'あ'] });
        const params = resolvedParamsWith(mesh.uuid, { ParamEyeLOpen: 0, ParamEyeROpen: 1, ParamMouthOpenY: 2 });

        const driver = new FacePoseDriver(mesh, params, root);
        driver.applyNeutral();
        const assignment = defaultAssignment();
        assignment.ParamEyeLOpen = 0.25;
        assignment.ParamEyeROpen = 0.5;
        assignment.ParamMouthOpenY = 0.75;
        driver.applyAssignment(assignment);

        expect(mesh.morphTargetInfluences![0]).toBeCloseTo(0.75);
        expect(mesh.morphTargetInfluences![1]).toBeCloseTo(0.5);
        expect(mesh.morphTargetInfluences![2]).toBeCloseTo(0.75);
    });

    it('is order independent: reapplying an assignment yields the same pose', () => {
        const { root, mesh, bones } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'] });
        const head = bones[0];
        const driver = new FacePoseDriver(mesh, resolvedParamsWith(mesh.uuid), root);
        driver.applyNeutral();

        const first = defaultAssignment();
        first.ParamAngleY = -15;
        const second = defaultAssignment();
        second.ParamAngleX = 25;

        driver.applyAssignment(second);
        driver.applyAssignment(first);
        const quaternionAfter = head.quaternion.clone();
        const influencesAfter = [...mesh.morphTargetInfluences!];

        driver.applyAssignment(second);
        driver.applyAssignment(first);
        expect(head.quaternion.angleTo(quaternionAfter)).toBeLessThan(1e-9);
        expect(mesh.morphTargetInfluences!).toEqual(influencesAfter);
    });

    it('restores the pre-bake pose after snapshot/restore', () => {
        const { root, mesh, bones } = buildSkinnedMesh({ boneNames: ['頭'], morphNames: ['あ'] });
        const head = bones[0];
        head.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8);
        mesh.morphTargetInfluences![0] = 0.7;
        root.updateMatrixWorld(true);

        const driver = new FacePoseDriver(mesh, resolvedParamsWith(mesh.uuid), root);
        const snapshot = driver.snapshot();
        driver.applyNeutral();
        const baked = defaultAssignment();
        baked.ParamAngleX = 30;
        baked.ParamMouthOpenY = 1;
        driver.applyAssignment(baked);

        driver.restore(snapshot);
        expect(head.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8))).toBeLessThan(1e-6);
        expect(mesh.morphTargetInfluences![0]).toBeCloseTo(0.7);
    });
});
