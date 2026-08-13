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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    if (layer === 'shadow') {
        const strength = clamp01(settings.shadowStrength);
        hsl.l = clamp(hsl.l * (1 - strength * 0.78), 0.02, 0.98);
    } else if (layer === 'highlight') {
        const strength = clamp01(settings.highlightStrength);
        hsl.l = clamp(hsl.l + (1 - hsl.l) * strength * 0.62, 0.02, 0.98);
    }
    color.setHSL(hsl.h, hsl.s, hsl.l);
    return toHex(color);
};

export const colorDistanceHex = (leftHex: string, rightHex: string) => {
    const left = colorFromHex(leftHex);
    const right = colorFromHex(rightHex);
    return Math.sqrt(
        (left.r - right.r) ** 2 +
            (left.g - right.g) ** 2 +
            (left.b - right.b) ** 2,
    );
};

export const medoidHexColor = (colors: string[]) => {
    if (colors.length === 0) {
        return '#FFFFFF';
    }
    if (colors.length === 1) {
        return colors[0];
    }

    let bestColor = colors[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    colors.forEach((candidate) => {
        const totalDistance = colors.reduce(
            (total, color) => total + colorDistanceHex(candidate, color),
            0,
        );
        if (totalDistance < bestDistance) {
            bestDistance = totalDistance;
            bestColor = candidate;
        }
    });
    return bestColor;
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
