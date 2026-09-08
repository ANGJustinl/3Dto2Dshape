import type { Point2D, ProjectedPartShape } from '../2DRenderShared/types';

const area = (loop: Point2D[]) => loop.reduce((sum, p, i) => {
    const q = loop[(i + 1) % loop.length];
    return sum + p.x * q.y - p.y * q.x;
}, 0);

/** Match cyclic vertex order in translation-free coordinates. Preserve seams,
 * holes and large silhouette changes instead of averaging unrelated edges. */
export const stabilizeContour = (
    current: ProjectedPartShape,
    previous: ProjectedPartShape,
    strength: number,
): Point2D[][] => {
    if (current.loops.length !== 1 || previous.loops.length !== 1 ||
        current.loopSharedRanges?.some((ranges) => ranges.length > 0) ||
        previous.loopSharedRanges?.some((ranges) => ranges.length > 0)) return current.loops;
    const loop = current.loops[0];
    const old = previous.loops[0];
    if (loop.length < 3 || loop.length !== old.length || loop.length > 128 ||
        Math.sign(area(loop)) !== Math.sign(area(old))) return current.loops;
    let bestShift = 0;
    let bestError = Infinity;
    for (let shift = 0; shift < loop.length; shift += 1) {
        let error = 0;
        for (let i = 0; i < loop.length; i += 1) {
            const p = loop[i];
            const q = old[(i + shift) % old.length];
            error += (p.x - current.centroid.x - q.x + previous.centroid.x) ** 2 +
                (p.y - current.centroid.y - q.y + previous.centroid.y) ** 2;
        }
        if (error < bestError) { bestError = error; bestShift = shift; }
    }
    const tolerance = Math.max(0.5, Math.min(2, Math.sqrt(current.area) * 0.05));
    if (Math.sqrt(bestError / loop.length) > tolerance) return current.loops;
    const weight = Math.min(0.6, Math.max(0, strength));
    return [loop.map((p, i) => {
        const q = old[(i + bestShift) % old.length];
        const dx = q.x - previous.centroid.x + current.centroid.x - p.x;
        const dy = q.y - previous.centroid.y + current.centroid.y - p.y;
        const limit = Math.min(1, tolerance / Math.max(1e-6, Math.hypot(dx, dy)));
        return { x: p.x + dx * weight * limit, y: p.y + dy * weight * limit };
    })];
};
