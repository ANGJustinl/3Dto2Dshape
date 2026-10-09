import type { ProjectionPartSource } from '../modelParts';
import type { ResolvedPartStyle } from '../2DRenderShared/focusResolver';
import type { MeshProjectionCache, PaintLayerKind, ProjectionOverlaySettings } from '../2DRenderShared/types';
import { VisibleRegionState, isProtectedPaintDetail } from './visibleRegions';

export type FlickerControlSettings = {
    shadeHysteresis: number;
    regionHysteresis: number;
    normalSmoothing: number;
    rasterScale?: 1 | 2;
    visibleMinArea?: number;
    visibleHysteresis?: number;
    reuseOutputCapacity?: boolean;
    stableOpaqueFill?: boolean;
};

export const FLICKER_PRESETS = {
    baseline: { shadeHysteresis: 0, regionHysteresis: 0, normalSmoothing: 0 },
    shade: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0 },
    regions: { shadeHysteresis: 0.02, regionHysteresis: 0.35, normalSmoothing: 0 },
    normals: { shadeHysteresis: 0, regionHysteresis: 0, normalSmoothing: 0.55 },
    combined: { shadeHysteresis: 0.02, regionHysteresis: 0.35, normalSmoothing: 0.55 },
    sampling: { shadeHysteresis: 0, regionHysteresis: 0, normalSmoothing: 0, rasterScale: 2 },
    visible: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0, visibleMinArea: 16, visibleHysteresis: .35 },
    visibleStrong: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0, visibleMinArea: 32, visibleHysteresis: .35 },
    fast: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0, reuseOutputCapacity: true },
    visibleFast: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0, visibleMinArea: 16, visibleHysteresis: .35, reuseOutputCapacity: true },
    opaque: { shadeHysteresis: 0.02, regionHysteresis: 0, normalSmoothing: 0, reuseOutputCapacity: true, stableOpaqueFill: true },
} satisfies Record<string, FlickerControlSettings>;

export type PaintFrameStats = {
    triangles: number;
    layerChanges: number;
    immediateReversals: number;
    mergedComponents: number;
    mergedTriangles: number;
    visibleMergedComponents?: number;
    visibleMergedPixels?: number;
    visibleImmediateReversals?: number;
};
const blankStats = (): PaintFrameStats => ({ triangles: 0, layerChanges: 0, immediateReversals: 0, mergedComponents: 0, mergedTriangles: 0 });
const layers: PaintLayerKind[] = ['shadow', 'base', 'highlight'];
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));

export const classifyShade = (shade: number, shadow: number, highlight: number, previous?: number, band = 0) => {
    const h = Math.min(clamp(band, 0.1), Math.max(0, (highlight - shadow) * 0.24));
    if (previous === 0 && shade <= shadow + h) return 0;
    if (previous === 2 && shade >= highlight - h) return 2;
    if (shade <= shadow - (previous === undefined ? 0 : h)) return 0;
    if (shade >= highlight + (previous === undefined ? 0 : h)) return 2;
    return 1;
};

type Topology = { adjacent: number[][] };
const topologies = new WeakMap<ProjectionPartSource['triangles'], Topology>();
const topologyFor = (part: ProjectionPartSource): Topology => {
    const cached = topologies.get(part.triangles);
    if (cached) return cached;
    const edges = new Map<string, number[]>();
    const adjacent = part.triangles.map(() => [] as number[]);
    part.triangles.forEach((triangle, index) => {
        const keys = triangle.vertexPositionKeys ?? triangle.vertexIndices.map(String);
        for (let i = 0; i < 3; i += 1) {
            const edge = [keys[i], keys[(i + 1) % 3]].sort().join('|');
            const owners = edges.get(edge) ?? [];
            for (const owner of owners) { adjacent[index].push(owner); adjacent[owner].push(index); }
            owners.push(index);
            edges.set(edge, owners);
        }
    });
    const topology = { adjacent };
    topologies.set(part.triangles, topology);
    return topology;
};

type PartHistory = { raw: Uint8Array; displayed: Uint8Array; before: Uint8Array | null };

/** History follows source triangles. It never carries old screen geometry into a new frame. */
export class TemporalPaintState {
    readonly visibleRegions = new VisibleRegionState();
    private histories = new WeakMap<ProjectionPartSource['triangles'], PartHistory>();
    private signature = '';
    private previousTime = -Infinity;
    private previousLight: [number, number, number] | null = null;
    private stats = blankStats();

    reset() {
        this.histories = new WeakMap();
        this.signature = '';
        this.previousTime = -Infinity;
        this.previousLight = null;
        this.stats = blankStats();
        this.visibleRegions.reset();
    }

    beginFrame(settings: ProjectionOverlaySettings, time: number, width: number, height: number) {
        const signature = JSON.stringify([settings.flickerControl, settings.styleMode, settings.shadowThreshold,
            settings.highlightThreshold, settings.minShapeArea, settings.partOverrides, settings.useAuthoredNormals, width, height]);
        const length = Math.hypot(...settings.lightDirection) || 1;
        const light = settings.lightDirection.map(value => value / length) as [number, number, number];
        const lightJump = this.previousLight && light.reduce((sum, value, i) => sum + value * this.previousLight![i], 0) < Math.cos(Math.PI / 12);
        if (signature !== this.signature || time < this.previousTime || time - this.previousTime > 1 || lightJump) this.reset();
        this.signature = signature;
        this.previousTime = time;
        this.previousLight = light;
        this.stats = blankStats();
        this.visibleRegions.beginFrame();
    }

    getStats(): PaintFrameStats {
        const visible = this.visibleRegions.getStats();
        return { ...this.stats, visibleMergedComponents: visible.mergedComponents, visibleMergedPixels: visible.mergedPixels, visibleImmediateReversals: visible.immediateReversals };
    }

    observePart(part: ProjectionPartSource, assignments: PaintLayerKind[]) {
        const displayed = Uint8Array.from(assignments, layer => layers.indexOf(layer));
        this.recordPart(part, displayed, displayed);
    }

    private recordPart(part: ProjectionPartSource, raw: Uint8Array, displayed: Uint8Array) {
        const previous = this.histories.get(part.triangles);
        for (let i = 0; i < displayed.length; i += 1) {
            this.stats.triangles += 1;
            if (previous && displayed[i] !== previous.displayed[i]) {
                this.stats.layerChanges += 1;
                if (previous.before && displayed[i] === previous.before[i]) this.stats.immediateReversals += 1;
            }
        }
        this.histories.set(part.triangles, { raw, displayed, before: previous?.displayed ?? null });
    }

    classifyPart(part: ProjectionPartSource, cache: MeshProjectionCache, settings: ProjectionOverlaySettings, style: ResolvedPartStyle): PaintLayerKind[] {
        const options = settings.flickerControl ?? FLICKER_PRESETS.baseline;
        const topology = topologyFor(part);
        const previous = this.histories.get(part.triangles);
        const count = part.triangles.length;
        const normals = new Float64Array(count * 3);
        const surfaceAreas = new Float64Array(count);
        const screenAreas = new Float64Array(count);
        part.triangles.forEach(({ vertexIndices: [a, b, c] }, i) => {
            const ux = cache.worldX[b] - cache.worldX[a], uy = cache.worldY[b] - cache.worldY[a], uz = cache.worldZ[b] - cache.worldZ[a];
            const vx = cache.worldX[c] - cache.worldX[a], vy = cache.worldY[c] - cache.worldY[a], vz = cache.worldZ[c] - cache.worldZ[a];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const length = Math.hypot(nx, ny, nz);
            surfaceAreas[i] = length * 0.5;
            if (length > 1e-12) { normals[i * 3] = nx / length; normals[i * 3 + 1] = ny / length; normals[i * 3 + 2] = nz / length; }
            if (settings.useAuthoredNormals && cache.worldNormals) {
                const n = cache.worldNormals;
                const x = n[a * 3] + n[b * 3] + n[c * 3], y = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1], z = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2];
                const l = Math.hypot(x, y, z);
                if (l > 1e-12) { normals[i * 3] = x / l; normals[i * 3 + 1] = y / l; normals[i * 3 + 2] = z / l; }
            }
            screenAreas[i] = Math.abs((cache.screenX[b] - cache.screenX[a]) * (cache.screenY[c] - cache.screenY[a]) -
                (cache.screenY[b] - cache.screenY[a]) * (cache.screenX[c] - cache.screenX[a])) * 0.5;
        });
        const lightLength = Math.hypot(...settings.lightDirection) || 1;
        const light = settings.lightDirection.map(value => value / lightLength);
        const raw = new Uint8Array(count);
        const smoothing = clamp(options.normalSmoothing, 1);
        for (let i = 0; i < count; i += 1) {
            let nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
            if (smoothing > 0 && surfaceAreas[i] > 1e-12) {
                let sx = nx * surfaceAreas[i], sy = ny * surfaceAreas[i], sz = nz * surfaceAreas[i];
                for (const neighbour of topology.adjacent[i]) {
                    const x = normals[neighbour * 3], y = normals[neighbour * 3 + 1], z = normals[neighbour * 3 + 2];
                    // Smooth only across a shared edge and a shallow crease, never across a material/part boundary.
                    if (nx * x + ny * y + nz * z < Math.cos(Math.PI * 35 / 180)) continue;
                    sx += x * surfaceAreas[neighbour]; sy += y * surfaceAreas[neighbour]; sz += z * surfaceAreas[neighbour];
                }
                const length = Math.hypot(sx, sy, sz) || 1;
                nx = nx * (1 - smoothing) + sx / length * smoothing;
                ny = ny * (1 - smoothing) + sy / length * smoothing;
                nz = nz * (1 - smoothing) + sz / length * smoothing;
                const mixedLength = Math.hypot(nx, ny, nz) || 1;
                nx /= mixedLength; ny /= mixedLength; nz /= mixedLength;
            }
            const shade = nx * light[0] + ny * light[1] + nz * light[2];
            raw[i] = classifyShade(shade, settings.shadowThreshold, settings.highlightThreshold, previous?.raw[i], options.shadeHysteresis);
        }
        const displayed = raw.slice();
        const protectedDetail = isProtectedPaintDetail(part) ||
            style.accentScore >= 0.8 || style.connectivityRole === 'accent';
        if (options.regionHysteresis > 0 && !protectedDetail) {
            const visited = new Uint8Array(count);
            const band = clamp(options.regionHysteresis, 0.8);
            // Use geometric components before rasterization, so suppressed shadow triangles become base fill rather than transparent holes.
            const minimum = Math.max(0, settings.minShapeArea) * (style.focusLevel === 'focal' ? 0.35 : 1);
            for (let start = 0; start < count; start += 1) {
                if (visited[start] || raw[start] === 1) continue;
                const layer = raw[start];
                const stack = [start], component: number[] = [];
                let area = 0, retainedArea = 0;
                visited[start] = 1;
                while (stack.length) {
                    const i = stack.pop()!;
                    component.push(i); area += screenAreas[i];
                    if (previous?.displayed[i] === layer) retainedArea += screenAreas[i];
                    for (const neighbour of topology.adjacent[i]) {
                        if (!visited[neighbour] && raw[neighbour] === layer) { visited[neighbour] = 1; stack.push(neighbour); }
                    }
                }
                const threshold = minimum * (retainedArea > area * 0.5 ? 1 - band : 1 + band);
                if (area < threshold) {
                    for (const i of component) displayed[i] = 1;
                    this.stats.mergedComponents += 1; this.stats.mergedTriangles += component.length;
                }
            }
        }
        this.recordPart(part, raw, displayed);
        return Array.from(displayed, value => layers[value]);
    }
}

export const projectionRasterScale = (settings: ProjectionOverlaySettings) => settings.flickerControl?.rasterScale === 2 ? 2 : 1;

/** Preserve screen-space styling when the visibility mask is sampled at a higher resolution. */
export const scaleProjectionPixelSettings = (settings: ProjectionOverlaySettings, scale: number): ProjectionOverlaySettings => scale === 1 ? settings : ({
    ...settings, simplifyEpsilon: settings.simplifyEpsilon * scale, strokeWidth: settings.strokeWidth * scale,
    minShapeArea: settings.minShapeArea * scale * scale, fillBleed: (settings.fillBleed ?? 0) * scale,
    gapMergeThreshold: settings.gapMergeThreshold * scale,
    flickerControl: settings.flickerControl ? { ...settings.flickerControl, visibleMinArea: (settings.flickerControl.visibleMinArea ?? 0) * scale * scale } : undefined,
});
