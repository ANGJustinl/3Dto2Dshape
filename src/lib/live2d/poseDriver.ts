import * as THREE from 'three';
import { FACE_PARAM_DEFINITIONS } from './paramMapping';
import type { ParamAssignment, ParamAxis, ResolvedFaceParam } from './types';

const AXIS_VECTORS: Record<ParamAxis, THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
};

type BoneNeutralPose = {
    bone: THREE.Bone;
    quaternion: THREE.Quaternion;
};

type PoseSnapshot = {
    boneQuaternions: Array<{ bone: THREE.Bone; quaternion: THREE.Quaternion }>;
    morphInfluences: number[] | null;
};

/**
 * Drives a skinned mesh directly from Live2D-style face parameters. Every
 * applyAssignment() rebuilds the pose from the bind pose, so consecutive
 * samples never depend on the previous assignment. ParamAngleX/Y/Z compose on
 * the same bone in fixed definition order (yaw, pitch, roll).
 *
 * The driver intentionally flattens the pose to neutral (mesh.pose() + zeroed
 * morphs): the bake must be reproducible regardless of whatever animation
 * was playing when it started. snapshot()/restore() puts the live scene back.
 */
export class FacePoseDriver {
    private readonly mesh: THREE.SkinnedMesh;
    private readonly root: THREE.Object3D;
    private readonly params: ResolvedFaceParam[];
    private readonly boneParamsByBone = new Map<string, ResolvedFaceParam[]>();
    private readonly boneNeutrals: BoneNeutralPose[] = [];

    constructor(mesh: THREE.SkinnedMesh, params: ResolvedFaceParam[], root: THREE.Object3D = mesh) {
        this.mesh = mesh;
        this.root = root;
        this.params = params;

        this.params.forEach((param) => {
            if (param.resolved?.boneName === undefined) {
                return;
            }
            const bucket = this.boneParamsByBone.get(param.resolved.boneName) ?? [];
            bucket.push(param);
            this.boneParamsByBone.set(param.resolved.boneName, bucket);
        });

        this.boneNeutrals = [...this.boneParamsByBone.keys()]
            .map((boneName) => this.mesh.skeleton.bones.find((bone) => bone.name === boneName))
            .filter((bone): bone is THREE.Bone => bone !== undefined)
            .map((bone) => ({ bone, quaternion: bone.quaternion.clone() }));
    }

    private updateMatrices() {
        this.mesh.updateMatrixWorld(true);
        this.root.updateMatrixWorld(true);
        this.mesh.skeleton.update();
    }

    applyNeutral() {
        this.mesh.pose();
        if (this.mesh.morphTargetInfluences) {
            this.mesh.morphTargetInfluences.fill(0);
        }
        // pose() may indirectly rebase driven bones; re-capture their neutral
        // local rotations so applyAssignment() always composes from bind state.
        this.boneNeutrals.length = 0;
        [...this.boneParamsByBone.keys()].forEach((boneName) => {
            const bone = this.mesh.skeleton.bones.find((candidate) => candidate.name === boneName);
            if (bone) {
                this.boneNeutrals.push({ bone, quaternion: bone.quaternion.clone() });
            }
        });
        this.updateMatrices();
    }

    applyAssignment(assignment: ParamAssignment) {
        this.mesh.pose();
        if (this.mesh.morphTargetInfluences) {
            this.mesh.morphTargetInfluences.fill(0);
        }

        this.boneNeutrals.forEach(({ bone, quaternion }) => {
            bone.quaternion.copy(quaternion);
        });

        const deltaQuaternion = new THREE.Quaternion();
        // FACE_PARAM_DEFINITIONS order (X, Y, Z) fixes the composition order
        // for params that share a bone.
        FACE_PARAM_DEFINITIONS.forEach((definition) => {
            const param = this.params.find((candidate) => candidate.id === definition.id);
            if (!param?.resolved || param.resolved.boneName === undefined) {
                return;
            }
            const bone = this.mesh.skeleton.bones.find(
                (candidate) => candidate.name === param.resolved!.boneName,
            );
            if (!bone || param.source.kind !== 'boneRotation') {
                return;
            }

            const value = assignment[param.id] ?? param.default;
            const angle =
                param.source.sign *
                (param.source.rotationScale ?? 1) *
                THREE.MathUtils.degToRad(value - param.default);
            deltaQuaternion.setFromAxisAngle(AXIS_VECTORS[param.source.axis], angle);
            bone.quaternion.multiply(deltaQuaternion);
        });

        this.params.forEach((param) => {
            if (!param.resolved || param.resolved.morphIndex === undefined) {
                return;
            }
            const value = THREE.MathUtils.clamp(
                assignment[param.id] ?? param.default,
                param.min,
                param.max,
            );
            const influence =
                param.source.kind === 'morph' && param.source.valueMap === 'inverse'
                    ? 1 - value
                    : value;
            if (this.mesh.morphTargetInfluences) {
                this.mesh.morphTargetInfluences[param.resolved.morphIndex] = influence;
            }
        });

        this.updateMatrices();
    }

    snapshot(): PoseSnapshot {
        return {
            boneQuaternions: this.mesh.skeleton.bones.map((bone) => ({
                bone,
                quaternion: bone.quaternion.clone(),
            })),
            morphInfluences: this.mesh.morphTargetInfluences
                ? [...this.mesh.morphTargetInfluences]
                : null,
        };
    }

    restore(snapshot: PoseSnapshot) {
        snapshot.boneQuaternions.forEach(({ bone, quaternion }) => {
            bone.quaternion.copy(quaternion);
        });
        if (snapshot.morphInfluences && this.mesh.morphTargetInfluences) {
            // morphTargetInfluences is a plain array in three.js, not a typed one.
            snapshot.morphInfluences.forEach((value, index) => {
                this.mesh.morphTargetInfluences![index] = value;
            });
        }
        this.updateMatrices();
    }
}
