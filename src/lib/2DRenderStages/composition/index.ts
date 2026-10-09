import type { GpuDepthAtlasState } from '../partRasterization/rasterizer';
import { getGpuOverlayComposer, type ComposeOptions } from './composer';
import type { ProjectedPartShape, ProjectionOverlaySettings } from '../../2DRenderShared/types';

export const clear2DRenderComposition = async (
    canvas: HTMLCanvasElement,
    viewportWidth: number,
    viewportHeight: number,
    settings?: ProjectionOverlaySettings,
    options?: ComposeOptions,
) => {
    await getGpuOverlayComposer().clear(
        canvas,
        viewportWidth,
        viewportHeight,
        settings,
        options?.transparent,
        options?.pixelRatio,
    );
};

export const compose2DRenderOverlay = async (
    canvas: HTMLCanvasElement,
    shapes: ProjectedPartShape[],
    viewportWidth: number,
    viewportHeight: number,
    settings: ProjectionOverlaySettings,
    depthAtlas: GpuDepthAtlasState | null,
    options?: ComposeOptions,
) => {
    return await getGpuOverlayComposer().render(
        canvas,
        shapes,
        viewportWidth,
        viewportHeight,
        settings,
        depthAtlas,
        options,
    );
};
