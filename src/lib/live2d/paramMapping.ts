import * as THREE from 'three';
import type { FaceParamDefinition, ParamAssignment, ResolvedFaceParam } from './types';

/**
 * MMD -> Live2D standard face parameter mapping, in the spirit of
 * MIXAMO_TO_TARGET_CANDIDATES: candidate chains with graceful degradation.
 * Bones rotate in their parent space on top of the neutral pose; morphs write
 * morphTargetInfluences directly. MouthForm (い/う/え/お) is deliberately out
 * of scope: MMD vowel morphs are not a 1D blend of ParamMouthForm.
 */
export const FACE_PARAM_DEFINITIONS: FaceParamDefinition[] = [
    {
        id: 'ParamAngleX',
        label: 'Head yaw',
        min: -30,
        max: 30,
        default: 0,
        source: { kind: 'boneRotation', boneNames: ['頭', 'head'], axis: 'y', sign: 1 },
    },
    {
        id: 'ParamAngleY',
        label: 'Head pitch',
        min: -30,
        max: 30,
        default: 0,
        source: { kind: 'boneRotation', boneNames: ['頭', '首', 'head', 'neck'], axis: 'x', sign: 1 },
    },
    {
        id: 'ParamAngleZ',
        label: 'Head roll',
        min: -30,
        max: 30,
        default: 0,
        source: { kind: 'boneRotation', boneNames: ['頭', 'head'], axis: 'z', sign: 1 },
    },
    {
        id: 'ParamEyeLOpen',
        label: 'Left eye open',
        min: 0,
        max: 1,
        default: 1,
        source: { kind: 'morph', morphNames: ['ウィンク', 'まばたき'], valueMap: 'inverse' },
    },
    {
        id: 'ParamEyeROpen',
        label: 'Right eye open',
        min: 0,
        max: 1,
        default: 1,
        source: { kind: 'morph', morphNames: ['ウィンク右', 'まばたき'], valueMap: 'inverse' },
    },
    {
        id: 'ParamMouthOpenY',
        label: 'Mouth open',
        min: 0,
        max: 1,
        default: 0,
        source: { kind: 'morph', morphNames: ['あ'], valueMap: 'direct' },
    },
];

export const defaultAssignment = (params: FaceParamDefinition[] = FACE_PARAM_DEFINITIONS): ParamAssignment => {
    const assignment = {} as ParamAssignment;
    params.forEach((param) => {
        assignment[param.id] = param.default;
    });
    return assignment;
};

/**
 * Resolve every param against the first skinned mesh that satisfies the most
 * params. Bones are matched by exact skeleton name; morphs through
 * morphTargetDictionary. A param whose chain misses entirely resolves to null
 * and is skipped during baking (it stays constant at its default).
 */
export const resolveFaceParams = (
    meshes: Array<THREE.SkinnedMesh | THREE.Mesh>,
    params: FaceParamDefinition[] = FACE_PARAM_DEFINITIONS,
): { mesh: THREE.SkinnedMesh | null; params: ResolvedFaceParam[] } => {
    let best: { mesh: THREE.SkinnedMesh; params: ResolvedFaceParam[] } | null = null;

    meshes.forEach((mesh) => {
        if (!(mesh instanceof THREE.SkinnedMesh)) {
            return;
        }

        const boneNames = new Set(mesh.skeleton.bones.map((bone) => bone.name));
        const morphDictionary = mesh.morphTargetDictionary ?? {};

        const resolved = params.map((param): ResolvedFaceParam => {
            if (param.source.kind === 'boneRotation') {
                const boneName = param.source.boneNames.find((candidate) => boneNames.has(candidate));
                return {
                    ...param,
                    resolved: boneName
                        ? { meshId: mesh.uuid, boneName, fallbackUsed: boneName !== param.source.boneNames[0] }
                        : null,
                };
            }

            const morphIndex = param.source.morphNames.find((candidate) => morphDictionary[candidate] !== undefined);
            return {
                ...param,
                resolved:
                    morphIndex !== undefined
                        ? {
                              meshId: mesh.uuid,
                              morphIndex: morphDictionary[morphIndex],
                              fallbackUsed: morphIndex !== param.source.morphNames[0],
                          }
                        : null,
            };
        });

        const resolvedCount = resolved.filter((param) => param.resolved !== null).length;
        if (!best || resolvedCount > best.params.filter((param) => param.resolved !== null).length) {
            best = { mesh, params: resolved };
        }
    });

    if (!best) {
        return { mesh: null, params: params.map((param) => ({ ...param, resolved: null })) };
    }
    return best;
};
