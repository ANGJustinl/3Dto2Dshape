export type BakeTextureOptions = {
    source: 'flat' | 'uv';
    tileParts: boolean;
    occlusionMask: boolean;
};

/** Existing scripted launches can set the initial choices before the panel mounts. */
export function initialBakeTextureOptions(): BakeTextureOptions {
    const flags = globalThis as typeof globalThis & {
        __uvTexturePick?: boolean;
        __uvBboxTile?: boolean;
        __uvOcclusionMask?: boolean;
    };
    const useUv = flags.__uvTexturePick === true;
    return {
        source: useUv ? 'uv' : 'flat',
        // A legacy UV-only launch used the full target; a new UI selection starts tiled.
        tileParts: flags.__uvBboxTile ?? !useUv,
        occlusionMask: flags.__uvOcclusionMask !== false,
    };
}
