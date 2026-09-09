type EyePart = { id: string; label: string; meshId: string };

/** Inverted face coverage preserves the actual eyelid opening. The sclera
 * alone stays partly open in this MMD rig and cannot guarantee closure. */
export const resolveEyeMaskIds = (drawable: EyePart, drawables: EyePart[]): string[] | undefined => {
    if (!/^(目|目光|目影|白目|眼白|瞳|瞳孔|虹膜)(?:-|$)|iris|pupil|sclera|eye[ _-]?(highlight|shine|shadow|white)/i.test(drawable.label)) return undefined;
    const masks = drawables.filter((candidate) => candidate.meshId === drawable.meshId &&
        candidate.id !== drawable.id && /^(顔|颜|face)(?:-|$)/i.test(candidate.label));
    return masks.length ? masks.map((mask) => mask.id) : undefined;
};
