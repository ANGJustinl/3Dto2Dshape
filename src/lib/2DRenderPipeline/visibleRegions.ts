import type { ProjectionPartSource } from '../modelParts';
import type { MeshProjectionCache, PaintLayerKind } from '../2DRenderShared/types';
import type { RasterizedPartData } from '../2DRenderStages/partRasterization/rasterizer';

export const isProtectedPaintDetail = (part: Pick<ProjectionPartSource, 'label' | 'materialNames' | 'accentScore' | 'connectivityRole'>) =>
    /(?:eye|eyes|mouth|眉|瞳|まつげ|睫毛|目影|眼影|眼|嘴|口)/i.test([part.label, ...part.materialNames].join(' ')) ||
    (part.accentScore ?? 0) >= 0.65 || part.connectivityRole === 'accent';

type Region = { x: number; y: number; depth: number; area: number; shown: boolean; before?: boolean };
export type VisibleRegionStats = { components: number; mergedComponents: number; mergedPixels: number; immediateReversals: number };
const blank = (): VisibleRegionStats => ({ components: 0, mergedComponents: 0, mergedPixels: 0, immediateReversals: 0 });

/** Carries only region decisions. Removed shade is replaced with current-frame base fill. */
export class VisibleRegionState {
    private histories = new WeakMap<ProjectionPartSource['triangles'], Partial<Record<PaintLayerKind, Region[]>>>();
    private stats = blank();
    reset() { this.histories = new WeakMap(); this.beginFrame(); }
    beginFrame() { this.stats = blank(); }
    getStats() { return { ...this.stats }; }

    process(source: ProjectionPartSource, layer: PaintLayerKind, raster: RasterizedPartData, cache: MeshProjectionCache, minimum: number, hysteresis: number) {
        const visited = new Uint8Array(raster.occupied.length), queue = new Int32Array(raster.occupied.length);
        const previous = this.histories.get(source.triangles) ?? {};
        const history = previous[layer] ?? [];
        const radius = Math.max(4, Math.sqrt(minimum) * 1.5), buckets = new Map<string, number[]>(), used = new Set<number>();
        const bucketKey = (x: number, y: number) => `${Math.floor(x / radius)}:${Math.floor(y / radius)}`;
        history.forEach((region, index) => { const key = bucketKey(region.x, region.y); const entries = buckets.get(key) ?? []; entries.push(index); buckets.set(key, entries); });
        let anchorX = 0, anchorY = 0, vertices = 0;
        for (const triangle of source.triangles) for (const vertex of triangle.vertexIndices) { anchorX += cache.screenX[vertex]; anchorY += cache.screenY[vertex]; vertices += 1; }
        anchorX /= vertices || 1; anchorY /= vertices || 1;
        const current: Region[] = [];
        let kept: Uint8Array | undefined, merged: Uint8Array | undefined;
        const band = Math.max(0, Math.min(.8, hysteresis));
        for (let start = 0; start < raster.occupied.length; start += 1) {
            if (!raster.occupied[start] || visited[start]) continue;
            let head = 0, tail = 1, sx = 0, sy = 0, depth = 0;
            queue[0] = start; visited[start] = 1;
            while (head < tail) {
                const index = queue[head++], x = index % raster.width, y = Math.floor(index / raster.width);
                sx += x + raster.offsetX + .5; sy += y + raster.offsetY + .5; depth += raster.depth[index];
                for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
                    if ((!dx && !dy) || x + dx < 0 || x + dx >= raster.width || y + dy < 0 || y + dy >= raster.height) continue;
                    const next = index + dy * raster.width + dx;
                    if (raster.occupied[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
                }
            }
            const x = sx / tail - anchorX, y = sy / tail - anchorY, z = depth / tail;
            const bx = Math.floor(x / radius), by = Math.floor(y / radius);
            let match = -1, distance = radius * radius;
            for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
                for (const index of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
                    const region = history[index], delta = (region.x - x) ** 2 + (region.y - y) ** 2;
                    if (used.has(index) || Math.abs(region.depth - z) > .01 || Math.max(region.area, tail) > Math.min(region.area, tail) * 4) continue;
                    if (delta < distance) { match = index; distance = delta; }
                }
            }
            const prior = match >= 0 ? history[match] : undefined;
            if (match >= 0) used.add(match);
            const shown = tail >= minimum * (prior?.shown ? 1 - band : 1 + band);
            current.push({ x, y, depth: z, area: tail, shown, before: prior?.shown });
            this.stats.components += 1;
            if (prior && shown !== prior.shown && shown === prior.before) this.stats.immediateReversals += 1;
            if (!shown) {
                kept ??= raster.occupied.slice(); merged ??= new Uint8Array(raster.occupied.length);
                for (let i = 0; i < tail; i += 1) { kept[queue[i]] = 0; merged[queue[i]] = 1; }
                this.stats.mergedComponents += 1; this.stats.mergedPixels += tail;
            }
        }
        previous[layer] = current; this.histories.set(source.triangles, previous);
        return { kept: kept ? { ...raster, occupied: kept, loops: undefined } : raster,
            merged: merged ? { ...raster, occupied: merged, loops: undefined } : null };
    }
}
