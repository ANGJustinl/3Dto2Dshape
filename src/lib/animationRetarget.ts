import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';

const MIXAMO_TO_TARGET_CANDIDATES: Record<string, string[]> = {
    Hips: ['センター', '下半身', 'hips', 'hip', 'root'],
    Spine: ['上半身', 'spine', 'spine1'],
    Spine1: ['上半身2', 'spine2', 'spine1', 'upperbody'],
    Spine2: ['首根元', 'spine3', 'chest', 'upperchest'],
    Neck: ['首', 'neck'],
    Head: ['頭', 'head'],
    LeftShoulder: ['左肩', 'leftshoulder', 'lshoulder'],
    LeftArm: ['左腕', 'leftarm', 'larm'],
    LeftForeArm: ['左ひじ', 'leftforearm', 'lelbow'],
    LeftHand: ['左手首', 'lefthand', 'lhand'],
    LeftUpLeg: ['左足', 'leftupleg', 'lthigh'],
    LeftLeg: ['左ひざ', 'leftleg', 'lknee'],
    LeftFoot: ['左足首', 'leftfoot', 'lankle'],
    LeftToeBase: ['左つま先', 'lefttoebase', 'ltoe'],
    RightShoulder: ['右肩', 'rightshoulder', 'rshoulder'],
    RightArm: ['右腕', 'rightarm', 'rarm'],
    RightForeArm: ['右ひじ', 'rightforearm', 'relbow'],
    RightHand: ['右手首', 'righthand', 'rhand'],
    RightUpLeg: ['右足', 'rightupleg', 'rthigh'],
    RightLeg: ['右ひざ', 'rightleg', 'rknee'],
    RightFoot: ['右足首', 'rightfoot', 'rankle'],
    RightToeBase: ['右つま先', 'righttoebase', 'rtoe'],
};

const normalizeBoneName = (name: string) => name.toLowerCase().replace(/[\s_.-]/g, '');

const findFirstSkinnedMesh = (root: THREE.Object3D) => {
    let found: THREE.SkinnedMesh | null = null;
    root.traverse((node) => {
        if (!found && node instanceof THREE.SkinnedMesh) {
            found = node;
        }
    });
    return found;
};

const findBonesInHierarchy = (root: THREE.Object3D) => {
    const bones: THREE.Bone[] = [];
    root.traverse((node) => {
        if (node instanceof THREE.Bone) {
            bones.push(node);
        }
    });
    return bones;
};

const findSourceBoneName = (sourceBones: THREE.Bone[], candidate: string) => {
    const normalizedCandidate = normalizeBoneName(candidate);
    const exact = sourceBones.find(
        (bone) => normalizeBoneName(bone.name) === normalizedCandidate,
    );
    if (exact) {
        return exact.name;
    }

    const suffix = sourceBones.find((bone) =>
        normalizeBoneName(bone.name).endsWith(normalizedCandidate),
    );
    if (suffix) {
        return suffix.name;
    }

    return null;
};

const buildMixamoToTargetMap = (
    targetSkeleton: THREE.Skeleton,
    sourceBones: THREE.Bone[],
) => {
    const targetBones = targetSkeleton.bones;
    const targetBoneByNormalizedName = new Map(
        targetBones.map((bone) => [normalizeBoneName(bone.name), bone.name]),
    );

    const names: Record<string, string> = {};
    Object.entries(MIXAMO_TO_TARGET_CANDIDATES).forEach(([mixamoName, candidates]) => {
        const targetName = candidates
            .map((candidate) => targetBoneByNormalizedName.get(normalizeBoneName(candidate)))
            .find((value): value is string => Boolean(value));
        if (!targetName) {
            return;
        }

        const sourceName = findSourceBoneName(sourceBones, mixamoName);
        if (!sourceName) {
            return;
        }

        names[targetName] = sourceName;
    });

    return names;
};

const getTargetHipName = (targetSkeleton: THREE.Skeleton) => {
    const targetBoneNames = new Set(targetSkeleton.bones.map((bone) => bone.name));
    if (targetBoneNames.has('下半身')) {
        return '下半身';
    }
    if (targetBoneNames.has('センター')) {
        return 'センター';
    }
    return targetSkeleton.bones[0]?.name ?? 'hips';
};

export const loadRetargetedMixamoClip = async (
    _targetRoot: THREE.Object3D,
    targetMesh: THREE.SkinnedMesh,
    url: string,
) => {
    const loader = new FBXLoader();
    const sourceRoot = await loader.loadAsync(url);
    const sourceMesh = findFirstSkinnedMesh(sourceRoot) as THREE.SkinnedMesh | null;
    const sourceBones: THREE.Bone[] = sourceMesh
        ? sourceMesh.skeleton.bones
        : findBonesInHierarchy(sourceRoot);
    if (sourceBones.length === 0) {
        throw new Error('Mixamo FBX does not contain a skeleton.');
    }

    const sourceAnimations = (sourceRoot as THREE.Object3D & { animations?: THREE.AnimationClip[] }).animations ?? [];
    const sourceClip = sourceAnimations[0];
    if (!sourceClip) {
        throw new Error('Mixamo FBX does not contain an animation clip.');
    }

    const names = buildMixamoToTargetMap(targetMesh.skeleton, sourceBones);
    const hip = getTargetHipName(targetMesh.skeleton);
    const sourceObject = sourceMesh ?? Object.assign(sourceRoot, {
        skeleton: new THREE.Skeleton(sourceBones),
    });
    const retargeted = retargetClip(targetMesh, sourceObject, sourceClip, {
        names,
        hip,
        useFirstFramePosition: true,
        preserveBoneMatrix: true,
    });

    retargeted.name = `${sourceClip.name || 'mixamo'}-retargeted`;
    return {
        clip: retargeted,
        mapping: names,
        sourceClipName: sourceClip.name || 'mixamo',
        sourceBoneNames: sourceBones.map((bone) => bone.name),
    };
};
