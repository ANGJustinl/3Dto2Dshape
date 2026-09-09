import type { ProjectionPartSource } from '../modelParts';
import type { ProjectedPartShape } from '../2DRenderShared/types';

/** Display-only override. Never mutate the shared shapes used for baking. */
export function previewEyeShadow(shapes: ProjectedPartShape[], parts: ProjectionPartSource[]): ProjectedPartShape[] {
    const ids = new Set(parts.filter(part => [part.label, ...part.materialNames].some(name =>
        /^(目影|眼影|eye[ _-]?shadow)(?:$|[\s_.-])/i.test(name.trim()))).map(part => part.leafId));
    return shapes.map(shape => ids.has(shape.sourceLeafId) ? {
        ...shape,
        color: '#000000',
        opacity: 1,
        previewFlatInk: true,
        edgeProfile: { ...shape.edgeProfile, mode: 'hard', hardness: 1, openness: 0 },
    } : shape);
}
