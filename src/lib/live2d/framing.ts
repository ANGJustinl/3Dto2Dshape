import type { FamilyKeyforms } from './keyforms';

export type GeometryBounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

export type GeometryFrameTransform = {
    scale: number;
    offsetX: number;
    offsetY: number;
    margin: number;
    sourceBounds: GeometryBounds;
    framedBounds: GeometryBounds;
};

const emptyBounds = (): GeometryBounds => ({
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
});

/**
 * Conservative additive-pose bounds. For each vertex, every parameter family
 * contributes its most-negative and most-positive displacement independently,
 * covering every possible combination without enumerating the full tensor.
 */
export const conservativeGeometryBounds = (
    neutralPositions: Float32Array[],
    families: Record<string, FamilyKeyforms>,
): GeometryBounds => {
    const bounds = emptyBounds();
    const familyList = Object.values(families);
    let packedOffset = 0;

    neutralPositions.forEach((positions) => {
        for (let local = 0; local < positions.length; local += 2) {
            const packed = packedOffset + local;
            let minDx = 0;
            let maxDx = 0;
            let minDy = 0;
            let maxDy = 0;

            familyList.forEach((family) => {
                let familyMinX = 0;
                let familyMaxX = 0;
                let familyMinY = 0;
                let familyMaxY = 0;
                family.displacements.forEach((block) => {
                    familyMinX = Math.min(familyMinX, block[packed] ?? 0);
                    familyMaxX = Math.max(familyMaxX, block[packed] ?? 0);
                    familyMinY = Math.min(familyMinY, block[packed + 1] ?? 0);
                    familyMaxY = Math.max(familyMaxY, block[packed + 1] ?? 0);
                });
                minDx += familyMinX;
                maxDx += familyMaxX;
                minDy += familyMinY;
                maxDy += familyMaxY;
            });

            bounds.minX = Math.min(bounds.minX, positions[local] + minDx);
            bounds.maxX = Math.max(bounds.maxX, positions[local] + maxDx);
            bounds.minY = Math.min(bounds.minY, positions[local + 1] + minDy);
            bounds.maxY = Math.max(bounds.maxY, positions[local + 1] + maxDy);
        }
        packedOffset += positions.length;
    });

    if (!Number.isFinite(bounds.minX)) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    return bounds;
};

/**
 * Fits all additive poses into the exported canvas with a uniform transform.
 * Translation applies only to neutral positions; displacements are scaled so
 * texture UVs remain pinned while every runtime pose shares the same frame.
 */
export const frameGeometryToViewport = (
    neutralPositions: Float32Array[],
    families: Record<string, FamilyKeyforms>,
    viewport: { width: number; height: number },
    requestedMargin = Math.max(16, Math.round(Math.min(viewport.width, viewport.height) * 0.024)),
) => {
    const sourceBounds = conservativeGeometryBounds(neutralPositions, families);
    const margin = Math.min(
        requestedMargin,
        Math.max(0, Math.floor(Math.min(viewport.width, viewport.height) / 2) - 1),
    );
    const sourceWidth = Math.max(1, sourceBounds.maxX - sourceBounds.minX);
    const sourceHeight = Math.max(1, sourceBounds.maxY - sourceBounds.minY);
    const targetWidth = Math.max(1, viewport.width - margin * 2);
    const targetHeight = Math.max(1, viewport.height - margin * 2);
    const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight);
    const sourceCenterX = (sourceBounds.minX + sourceBounds.maxX) / 2;
    const sourceCenterY = (sourceBounds.minY + sourceBounds.maxY) / 2;
    const offsetX = viewport.width / 2 - sourceCenterX * scale;
    const offsetY = viewport.height / 2 - sourceCenterY * scale;

    const framedNeutralPositions = neutralPositions.map((positions) => {
        const framed = new Float32Array(positions.length);
        for (let index = 0; index < positions.length; index += 2) {
            framed[index] = positions[index] * scale + offsetX;
            framed[index + 1] = positions[index + 1] * scale + offsetY;
        }
        return framed;
    });
    const framedFamilies = Object.fromEntries(
        Object.entries(families).map(([id, family]) => [
            id,
            {
                ...family,
                values: [...family.values],
                displacements: family.displacements.map((block) => {
                    const framed = new Float32Array(block.length);
                    for (let index = 0; index < block.length; index += 1) {
                        framed[index] = block[index] * scale;
                    }
                    return framed;
                }),
            },
        ]),
    ) as Record<string, FamilyKeyforms>;
    const framedBounds = {
        minX: sourceBounds.minX * scale + offsetX,
        minY: sourceBounds.minY * scale + offsetY,
        maxX: sourceBounds.maxX * scale + offsetX,
        maxY: sourceBounds.maxY * scale + offsetY,
    };

    return {
        neutralPositions: framedNeutralPositions,
        families: framedFamilies,
        transform: {
            scale,
            offsetX,
            offsetY,
            margin,
            sourceBounds,
            framedBounds,
        } satisfies GeometryFrameTransform,
    };
};
