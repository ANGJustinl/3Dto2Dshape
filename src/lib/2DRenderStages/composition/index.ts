import type { GpuDepthAtlasState } from '../partRasterization/rasterizer';
import { getGpuOverlayComposer } from './composer';
import type { ProjectedPartShape, ProjectionOverlaySettings } from '../../2DRenderShared/types';

export const clear2DRenderComposition = async (
    canvas: HTMLCanvasElement,
    viewportWidth: number,
    viewportHeight: number,
) => {
    await getGpuOverlayComposer().clear(canvas, viewportWidth, viewportHeight);
};

export const compose2DRenderOverlay = async (
    canvas: HTMLCanvasElement,
    shapes: ProjectedPartShape[],
    viewportWidth: number,
    viewportHeight: number,
    settings: ProjectionOverlaySettings,
    depthAtlas: GpuDepthAtlasState | null,
) => {
    await getGpuOverlayComposer().render(
        canvas,
        shapes,
        viewportWidth,
        viewportHeight,
        settings,
        depthAtlas,
    );
};
