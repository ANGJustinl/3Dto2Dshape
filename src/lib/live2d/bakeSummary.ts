import type { BakeBundle, BakeSample, FaceParamId } from './types';

/**
 * Post-bake analysis. Motion energy per part per parameter family tells M1
 * which parts actually need keyforms for which families (a torso part that
 * never moves under any face param needs only its base form), and the neutral
 * depth ordering feeds M3's draw-order decisions.
 */

const MOVING_THRESHOLD_PX = 0.5;

export type PartFamilyMotion = {
    leafId: string;
    family: FaceParamId;
    maxDisplacementPx: number;
    meanDisplacementPx: number;
};

export type PartDepthStat = {
    leafId: string;
    medianDepthAtNeutral: number;
};

export type BakeSummary = {
    sampleCounts: {
        total: number;
        neutral: number;
        familySweep: number;
        comboQa: number;
    };
    resolvedParams: FaceParamId[];
    unresolvedParams: FaceParamId[];
    motion: PartFamilyMotion[];
    movingLeafCountByFamily: Partial<Record<FaceParamId, number>>;
    depthAtNeutral: PartDepthStat[];
};

const meshVerticesByPart = (bundle: BakeBundle) => {
    const byPart = new Map<string, { meshId: string; indices: number[] }>();
    bundle.parts.forEach((part) => {
        const indices = new Set<number>();
        part.triangles.forEach(([a, b, c]) => {
            indices.add(a);
            indices.add(b);
            indices.add(c);
        });
        byPart.set(part.leafId, { meshId: part.meshId, indices: [...indices] });
    });
    return byPart;
};

const sampleMesh = (sample: BakeSample, meshId: string) =>
    sample.meshes.find((mesh) => mesh.meshId === meshId)?.vertices ?? null;

const median = (values: number[]) => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const summarizeBake = (bundle: BakeBundle): BakeSummary => {
    const neutral = bundle.samples.find((sample) => sample.kind === 'neutral') ?? null;
    const verticesByPart = meshVerticesByPart(bundle);

    const families = [
        ...new Set(
            bundle.samples
                .filter((sample) => sample.kind === 'family-sweep' && sample.family)
                .map((sample) => sample.family as FaceParamId),
        ),
    ];

    const motion: PartFamilyMotion[] = [];
    families.forEach((family) => {
        const familySamples = bundle.samples.filter((sample) => sample.family === family);

        bundle.parts.forEach((part) => {
            const partVertices = verticesByPart.get(part.leafId);
            if (!partVertices || !neutral) {
                return;
            }
            const neutralMesh = sampleMesh(neutral, partVertices.meshId);
            if (!neutralMesh) {
                return;
            }

            let maxDisplacement = 0;
            let displacementSum = 0;
            partVertices.indices.forEach((vertexIndex) => {
                let vertexMax = 0;
                familySamples.forEach((sample) => {
                    const sampleVertices = sampleMesh(sample, partVertices.meshId);
                    if (!sampleVertices) {
                        return;
                    }
                    const dx = sampleVertices.screenX[vertexIndex] - neutralMesh.screenX[vertexIndex];
                    const dy = sampleVertices.screenY[vertexIndex] - neutralMesh.screenY[vertexIndex];
                    vertexMax = Math.max(vertexMax, Math.hypot(dx, dy));
                });
                maxDisplacement = Math.max(maxDisplacement, vertexMax);
                displacementSum += vertexMax;
            });

            motion.push({
                leafId: part.leafId,
                family,
                maxDisplacementPx: maxDisplacement,
                meanDisplacementPx: partVertices.indices.length > 0
                    ? displacementSum / partVertices.indices.length
                    : 0,
            });
        });
    });

    const movingLeafCountByFamily: Partial<Record<FaceParamId, number>> = {};
    families.forEach((family) => {
        movingLeafCountByFamily[family] = bundle.parts.filter((part) => {
            const entry = motion.find(
                (candidate) => candidate.leafId === part.leafId && candidate.family === family,
            );
            return (entry?.maxDisplacementPx ?? 0) > MOVING_THRESHOLD_PX;
        }).length;
    });

    const depthAtNeutral: PartDepthStat[] = [];
    if (neutral) {
        bundle.parts.forEach((part) => {
            const partVertices = verticesByPart.get(part.leafId);
            const neutralMesh = partVertices ? sampleMesh(neutral, partVertices.meshId) : null;
            if (!partVertices || !neutralMesh) {
                return;
            }
            depthAtNeutral.push({
                leafId: part.leafId,
                medianDepthAtNeutral: median(
                    partVertices.indices.map((vertexIndex) => neutralMesh.depth[vertexIndex] ?? 0),
                ),
            });
        });
    }

    return {
        sampleCounts: {
            total: bundle.samples.length,
            neutral: bundle.samples.filter((sample) => sample.kind === 'neutral').length,
            familySweep: bundle.samples.filter((sample) => sample.kind === 'family-sweep').length,
            comboQa: bundle.samples.filter((sample) => sample.kind === 'combo-qa').length,
        },
        resolvedParams: bundle.params.filter((param) => param.resolved).map((param) => param.id),
        unresolvedParams: bundle.params.filter((param) => !param.resolved).map((param) => param.id),
        motion,
        movingLeafCountByFamily,
        depthAtNeutral,
    };
};

/** Compact per-family digest for UI display. */
export const familyDigest = (summary: BakeSummary) =>
    Object.entries(summary.movingLeafCountByFamily).map(([family, count]) => ({
        family,
        movingParts: count,
        totalParts: summary.motion.length > 0
            ? summary.motion.filter((entry) => entry.family === family).length
            : 0,
    }));
