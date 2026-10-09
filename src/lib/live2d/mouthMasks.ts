type MaskPart = { id: string; label: string; meshId: string; facialRole?: 'skin'|'feature'; maskOnly?: boolean };

/** Resolve actual drawable IDs; material labels and export IDs are different. */
export const resolveMouthMaskIds = (drawable: MaskPart, drawables: MaskPart[]): string[] | undefined => {
    if (!/齿|歯|牙|舌|teeth|tooth|tongue/i.test(drawable.label)) return undefined;
    const mask = drawables.find((candidate) =>
        candidate.id !== drawable.id && candidate.meshId === drawable.meshId &&
        /^(顔|颜|face)(?:-|$)/i.test(candidate.label),
    );
    return mask ? [mask.id] : undefined;
};

/** Mouth interiors use the opening in the deforming face, not lip-line ink. */
export function enforceMouthOrder<T extends MaskPart>(drawables: T[], order: string[]): string[] {
    const result = [...order];
    const anatomicalMeshes=new Set(drawables.filter(d=>d.facialRole==='skin').map(d=>d.meshId));
    for (const face of drawables.filter(d=>d.facialRole==='skin'||(!anatomicalMeshes.has(d.meshId)&&/^(顔|颜|face)(?:-|$)/i.test(d.label)))) {
        const mouth = result.filter((id) => drawables.some((d) => d.id === id && d.meshId === face.meshId &&
            (d.facialRole==='feature'||/口|齿|歯|牙|舌|睫|目|眼|瞳|眉|二重|mouth|lip|teeth|tooth|tongue|eye|iris|lash|brow/i.test(d.label))));
        for (const id of mouth) result.splice(result.indexOf(id), 1);
        result.splice(result.indexOf(face.id) + 1, 0, ...mouth);
        // Neutral median depth can put head-wrapping bangs behind the face
        // in a frontal camera. Front hair must occlude facial overlays.
        const frontHair = result.filter((id) => drawables.some((d) => d.id === id &&
            d.meshId === face.meshId && /前髪|前髮|前发|bang|fringe/i.test(d.label)));
        for (const id of frontHair) result.splice(result.indexOf(id), 1);
        const lastFeature = Math.max(result.indexOf(face.id), ...mouth.map((id) => result.indexOf(id)));
        result.splice(lastFeature + 1, 0, ...frontHair);
    }
    return result;
}
