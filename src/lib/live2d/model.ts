import type { ComboErrorReport, FamilyKeyforms, ScalarFamilyKeyforms } from './keyforms';
import type { OrderFlip } from './order';
import type { FaceParamDefinition, FaceParamId } from './types';

/** Slider-facing param definition (source binding stripped). */
export type Live2dParamDefinition = Pick<
    FaceParamDefinition,
    'id' | 'label' | 'min' | 'max' | 'default'
> & { id: FaceParamId };

/**
 * The runtime-facing Live2D model produced by build.ts (M1-M3) and consumed by
 * the preview runtime (M4) and the zip serializer (M5). It is deliberately
 * free of three.js objects: every buffer is plain typed-array data.
 */

export type Live2dTexture = {
    width: number;
    height: number;
    /** Top-down RGBA rows. */
    rgba: Uint8Array;
};

export type Live2dDrawable = {
    id: string;
    label: string;
    meshId: string;
    leafIds: string[];
    vertexCount: number;
    triangleCount: number;
    /** Triangles as indices into this drawable's compacted vertex table. */
    triangles: Uint32Array;
    /** Original mesh vertex index per compacted vertex. */
    meshVertexIndices: Uint32Array;
    /** Neutral-pose xy screen positions (bake viewport space). */
    neutralPositions: Float32Array;
    /** UVs into texture, derived from the neutral crop window. */
    uvs: Float32Array;
    texture: Live2dTexture;
    /** Painter's order: smaller renders first (farther). */
    renderOrder: number;
    /**
     * Ids of drawables whose opaque region masks this drawable (Cubism
     * masking): anything this drawable draws outside the union of the
     * maskers' rendered area is clipped. Empty = unmasked.
     */
    maskIds?: string[];
};

export type Live2dModel = {
    schemaVersion: 1;
    createdAt: string;
    modelName: string;
    viewport: { width: number; height: number };
    params: Live2dParamDefinition[];
    drawables: Live2dDrawable[];
    families: Record<string, FamilyKeyforms>;
    /** Per-drawable median depth keyforms for dynamic draw ordering. */
    depthFamilies: Record<string, ScalarFamilyKeyforms>;
    /** Median NDC depth per drawable at the neutral pose. */
    neutralDepths: number[];
    /** Drawable ids, far-to-near. */
    order: string[];
    /** Supersample factor the textures were baked at (atlas = 2048 * scale). */
    textureScale?: number;
    /**
     * Occlusion-aware draw orders per pose key (from the sweep samples):
     * orders[k] lists drawable indices far-to-near at values[k].
     */
    poseDrawOrders?: Array<{
        family: string;
        values: number[];
        orders: number[][];
    }>;
    errorReport: ComboErrorReport;
    orderReport: {
        flips: OrderFlip[];
        samplesChecked: number;
    };
};
