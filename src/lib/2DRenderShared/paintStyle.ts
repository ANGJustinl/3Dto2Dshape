import * as THREE from 'three';
import type { PaintLayerKind, ProjectionOverlaySettings } from './types';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const colorFromHex = (hex: string) => {
    const color = new THREE.Color();
    try {
        color.set(hex);
    } catch {
        color.set('#ffffff');
    }
    return color;
};

const toHex = (color: THREE.Color) => `#${color.getHexString().toUpperCase()}`;

export const getPaintLayerForShade = (
    shade: number,
    settings: ProjectionOverlaySettings,
): PaintLayerKind => {
    if (shade <= settings.shadowThreshold) {
        return 'shadow';
    }
    if (shade >= settings.highlightThreshold) {
        return 'highlight';
    }
    return 'base';
};

export const shadeColorForLayer = (
    baseHex: string,
    layer: PaintLayerKind,
    settings: ProjectionOverlaySettings,
) => {
    const color = colorFromHex(baseHex);
    if (layer === 'shadow') {
        const strength = clamp01(settings.shadowStrength);
        color.lerp(new THREE.Color('#554A4A'), strength);
    } else if (layer === 'highlight') {
        const strength = clamp01(settings.highlightStrength);
        color.lerp(new THREE.Color('#FFF6E8'), strength);
    }
    return toHex(color);
};

export const perturbPaintLoop = (
    points: Array<{ x: number; y: number }>,
    roughness: number,
    seed: number,
) => {
    if (roughness <= 0 || points.length < 3) {
        return points;
    }

    return points.map((point, index) => {
        const value = Math.sin((seed + 1) * 12.9898 + (index + 1) * 78.233) * 43758.5453;
        const normalized = value - Math.floor(value);
        const angle = (index / points.length) * Math.PI * 2;
        const distance = (normalized * 2 - 1) * roughness;
        return {
            x: point.x + Math.cos(angle) * distance,
            y: point.y + Math.sin(angle) * distance,
        };
    });
};
