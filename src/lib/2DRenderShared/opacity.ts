import type { EdgeMode } from './types';

/** Apply material alpha exactly once; old shapes without alpha remain opaque. */
export const shapeAlpha = (materialOpacity: number | undefined, layerOpacity: number): number => {
    const material = materialOpacity ?? 1;
    const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    return clamp(material) * clamp(layerOpacity);
};

/** Whole-fill transparency changes with draw order, even when the material is opaque. */
export const paintFillAlphaScale = (mode: EdgeMode, opacity: number, stabilizeOpaqueFill = false): number =>
    mode !== 'soft' || (stabilizeOpaqueFill && opacity === 1) ? 1 : 0.92;
