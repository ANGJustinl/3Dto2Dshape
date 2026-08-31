/**
 * Face-parameter bake types (M0 of the Live2D pipeline).
 *
 * A bake captures, for a fixed camera, the projected vertex positions of every
 * mesh at a set of parameter assignments (head angle sweeps, eye blinks,
 * mouth shapes, plus random combination samples used to measure the error of
 * additive keyform composition later). The bundle is runtime-agnostic: it
 * stores raw per-mesh vertex buffers plus the static, pose-independent part
 * triangle lists produced by splitModelParts.
 */

export type FaceParamId =
    | 'ParamAngleX'
    | 'ParamAngleY'
    | 'ParamAngleZ'
    | 'ParamEyeLOpen'
    | 'ParamEyeROpen'
    | 'ParamMouthOpenY';

export type ParamAxis = 'x' | 'y' | 'z';

export type FaceParamSource =
    | {
          kind: 'boneRotation';
          /** Fallback chain; the first bone present on the skeleton wins. */
          boneNames: string[];
          axis: ParamAxis;
          /** Sign is tuned against the Live2D convention at the runtime milestone. */
          sign: 1 | -1;
          /** Live2D parameter units need not equal physical bone degrees. */
          rotationScale?: number;
      }
    | {
          kind: 'morph';
          /** Fallback chain over morphTargetDictionary keys. */
          morphNames: string[];
          /** 'inverse': influence = 1 - value (open-1..closed-0 params drive wink morphs). */
          valueMap: 'direct' | 'inverse';
      };

export type FaceParamDefinition = {
    id: FaceParamId;
    label: string;
    min: number;
    max: number;
    default: number;
    source: FaceParamSource;
};

/** A definition with the concrete bone/morph it resolved to, or null if absent. */
export type ResolvedFaceParam = FaceParamDefinition & {
    resolved: {
        meshId: string;
        boneName?: string;
        morphIndex?: number;
        fallbackUsed?: boolean;
    } | null;
};

/** Complete assignment: every param carries an explicit value. */
export type ParamAssignment = Record<FaceParamId, number>;

export type BakeVertexSample = {
    screenX: Float32Array;
    screenY: Float32Array;
    depth: Float32Array;
};

export type BakeMeshSample = {
    meshId: string;
    vertices: BakeVertexSample;
};

export type BakeSampleKind = 'neutral' | 'family-sweep' | 'combo-qa';

export type BakeSample = {
    id: string;
    kind: BakeSampleKind;
    /** Set for family-sweep samples. */
    family?: FaceParamId;
    index: number;
    assignment: ParamAssignment;
    viewport: {
        width: number;
        height: number;
    };
    meshes: BakeMeshSample[];
};

/** Static part data copied from ProjectionPartSource; pose-independent. */
export type BakePartSnapshot = {
    leafId: string;
    label: string;
    meshId: string;
    color: string;
    triangleCount: number;
    /** Vertex indices into the per-mesh vertex arrays of bake samples. */
    triangles: Array<[number, number, number]>;
};

export type BakeBundle = {
    schemaVersion: 1;
    createdAt: string;
    modelName: string;
    params: ResolvedFaceParam[];
    parts: BakePartSnapshot[];
    samples: BakeSample[];
};

export const bakeAssignmentKey = (assignment: ParamAssignment) =>
    (Object.keys(assignment) as FaceParamId[])
        .sort()
        .map((key) => `${key}=${assignment[key].toFixed(4)}`)
        .join('|');
