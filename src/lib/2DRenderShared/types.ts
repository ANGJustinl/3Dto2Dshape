import type { ProjectionSharedChain } from '../modelParts';
import type { OrientedBounds2D } from '../orientedBounds';

export type ProjectionOverlaySettings = {
    enabled: boolean;
    simplifyEpsilon: number;
    strokeWidth: number;
    showContours: boolean;
    opacity: number;
    minTriangleCount: number;
};

export type ProjectedPartShape = {
    leafId: string;
    color: string;
    depth: number;
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
};
