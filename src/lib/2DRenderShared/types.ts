import type { ProjectionSharedChain } from '../modelParts';
import type { OrientedBounds2D } from '../orientedBounds';

export type ProjectionOverlaySettings = {
    enabled: boolean;
    styleMode: ProjectionStyleMode;
    simplifyEpsilon: number;
    strokeWidth: number;
    showContours: boolean;
    opacity: number;
    minTriangleCount: number;
    backgroundColor: string;
    outlineColor: string;
    outlineOpacity: number;
    shadowStrength: number;
    highlightStrength: number;
    shadowThreshold: number;
    highlightThreshold: number;
    lightDirection: [number, number, number];
    minShapeArea: number;
    edgeRoughness: number;
    edgeSmoothing: EdgeSmoothing;
    compositionMode: CompositionMode;
    boundaryGuard: BoundaryGuard;
    depthMergeThreshold: number;
    normalMergeThreshold: number;
    gapMergeThreshold: number;
    temporalStability: number;
    globalShapeBudget: number;
    focusShapeBudgets: Record<Exclude<FocusLevel, 'auto'>, number>;
    mergeColorThreshold: number;
    partOverrides: Record<string, ProjectionPartStyleOverride>;
};

export type PaintLayerKind = 'shadow' | 'base' | 'highlight';

export type ProjectionStyleMode = 'animationStable' | 'stillPainterly';

export type FocusLevel = 'auto' | 'focal' | 'support' | 'abstract';

export type MacroGroup = 'face' | 'hair' | 'torso' | 'lowerMass' | 'accent' | 'other';

export type EdgeMode = EdgeSmoothing;

export type EdgeSmoothing = 'hard' | 'soft' | 'open';

export type CompositionMode = 'vector' | 'raster';

export type BoundaryGuard = 'outer' | 'outerDepthNormal' | 'depthNormal' | 'outerDepthNormalGap';

export type EdgeProfile = {
    mode: EdgeMode;
    hardness: number;
    openness: number;
    seed: number;
};

export type ProjectionPartStyleOverride = {
    focusLevel?: Exclude<FocusLevel, 'auto'>;
    shapeBudget?: number;
    simplifyMultiplier?: number;
};

export type ProjectedPartShape = {
    leafId: string;
    sourceLeafId: string;
    paintLayer: PaintLayerKind;
    stableId: string;
    focusLevel: Exclude<FocusLevel, 'auto'>;
    macroGroup: MacroGroup;
    shapeBudget?: number;
    edgeProfile: EdgeProfile;
    sourceColors: string[];
    accentScore?: number;
    connectivityRole?: 'normal' | 'bridge' | 'accent';
    color: string;
    depth: number;
    depthSource?: 'atlas' | 'constant';
    depthRange: [number, number];
    normal: [number, number, number];
    area: number;
    centroid: Point2D;
    loops: Array<Array<{ x: number; y: number }>>;
    rasterBounds: {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
    };
    atlasRegion: {
        atlasX: number;
        atlasY: number;
        atlasWidth: number;
        atlasHeight: number;
    };
    orientedBounds: OrientedBounds2D;
};

export type ProjectionMaskState = {
    sharedChains: ProjectionSharedChain[];
};

export type Point2D = { x: number; y: number };

export type MaskBounds = {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
};

export type ProjectedSharedChain = {
    id: string;
    originalPoints: Point2D[];
    simplifiedPoints: Point2D[];
};

export type MeshProjectionCache = {
    width: number;
    height: number;
    screenX: Float32Array;
    screenY: Float32Array;
    depth: Float32Array;
    worldX: Float32Array;
    worldY: Float32Array;
    worldZ: Float32Array;
};
