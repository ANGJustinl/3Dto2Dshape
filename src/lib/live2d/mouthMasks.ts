type MaskPart = { id: string; label: string; meshId: string };

/** Resolve actual drawable IDs; material labels and export IDs are different. */
export const resolveMouthMaskIds = (drawable: MaskPart, drawables: MaskPart[]): string[] | undefined => {
    if (!/齿|歯|牙|舌|teeth|tooth|tongue/i.test(drawable.label)) return undefined;
    const mask = drawables.find((candidate) =>
        candidate.id !== drawable.id && candidate.meshId === drawable.meshId &&
        /口线|口線|mouth[ _-]?(mask|line)|lip[ _-]?(line|mask)/i.test(candidate.label),
    );
    return mask ? [mask.id] : undefined;
};
