import * as THREE from 'three';
import {
    DEFAULT_BAKE_VIEWPORT,
    bakePartsFromSources,
    collectBakeSamples,
    resolveBakeTargets,
    type BakeProjector,
} from './bake';
import {
    decomposeDrawables,
    drawableBoundsAtNeutral,
    drawableNeutralPositions,
} from './decomposition';
import { buildFamilyKeyforms, buildDepthKeyforms, createPoseEvaluator, evaluateComboError } from './keyforms';
import type { Live2dDrawable, Live2dModel, Live2dTexture } from './model';
import { computeDrawOrder, checkOrderConsistency, medianDepth } from './order';
import { computePoseDrawOrders } from './occlusionOrder';
import type { ProjectionPartSource } from '../modelParts';
import type { BakeBundle } from './types';

/**
 * M1-M3 assembly: face bake -> pose-invariant decomposition -> isolated
 * textures -> keyforms -> draw order -> error report, producing a complete
 * Live2dModel.
 *
 * renderIsolated is injected by the app because only it owns the WebGL
 * renderer/scene: it must render ONLY the given leaves with the given camera
 * at the given viewport and return raw RGBA (bottom-up rows, as produced by
 * readRenderTargetPixels). It is invoked while the model holds the neutral
 * pose, matching the neutral sample's projected geometry exactly.
 */
export type IsolatedRenderResult = {
    rgba: Uint8Array;
    width: number;
    height: number;
};

export type BuildOptions = {
    root: THREE.Object3D;
    parts: ProjectionPartSource[];
    camera: THREE.PerspectiveCamera;
    projector: BakeProjector;
    modelName: string;
    viewport?: { width: number; height: number };
    comboCount?: number;
    seed?: number;
    texturePad?: number;
    /** Supersample factor for baked drawable textures (1 = viewport resolution). */
    textureScale?: number;
    /**
     * Preferred texture source: the stylized 2D composition pipeline (paint
     * layers + contours). Returns bottom-up RGBA like renderIsolated, or
     * null to fall back to the raw isolated 3D render.
     */
    renderDrawable2D?: (
        leafIds: string[],
        camera: THREE.PerspectiveCamera,
        viewport: { width: number; height: number },
    ) => Promise<IsolatedRenderResult | null>;
    renderIsolated: (
        leafIds: string[],
        camera: THREE.PerspectiveCamera,
        viewport: { width: number; height: number },
    ) => IsolatedRenderResult;
    onProgress?: (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void;
};

const cropTopDown = (
    render: IsolatedRenderResult,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    pad: number,
    viewport: { width: number; height: number },
): { texture: Live2dTexture; cropX: number; cropY: number } => {
    const cropX1 = Math.max(0, Math.floor(bounds.minX - pad));
    const cropY1 = Math.max(0, Math.floor(bounds.minY - pad));
    const cropX2 = Math.min(viewport.width, Math.ceil(bounds.maxX + pad));
    const cropY2 = Math.min(viewport.height, Math.ceil(bounds.maxY + pad));
    const width = Math.max(1, cropX2 - cropX1);
    const height = Math.max(1, cropY2 - cropY1);

    const rgba = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
        // Source rows are bottom-up (GL readback); output is top-down.
        const sourceRow = render.height - 1 - (cropY1 + row);
        const sourceStart = (sourceRow * render.width + cropX1) * 4;
        rgba.set(
            render.rgba.subarray(sourceStart, sourceStart + width * 4),
            row * width * 4,
        );
    }

    return { texture: { width, height, rgba }, cropX: cropX1, cropY: cropY1 };
};

/** Bumped with every pipeline behavior change so stale bakes are detectable. */
export const PIPELINE_VERSION = '2026-08-30.9';

/**
 * Mouth-interior parts (teeth, tongue) clip to the lip-line drawable, the
 * Cubism mouth-mask idiom: at head turns the interior parts displace further
 * than the lips and would spill past the mouth outline without the mask.
 */
const mouthMaskIds = (label: string): string[] | undefined => {
    // The lip-line drawable's id is deterministically derived from its own
    // label (id === label), so no forward reference to the drawable list is
    // needed inside the map that builds it.
    if (!/^(D齿|D口舌)/.test(label)) {
        return undefined;
    }
    return ['D口线-18'];
};

export const buildLive2dModel = async (options: BuildOptions): Promise<{
    model: Live2dModel;
    bundle: BakeBundle;
}> => {
    const {
        root,
        parts,
        camera,
        projector,
        modelName,
        viewport = DEFAULT_BAKE_VIEWPORT,
        comboCount = 100,
        seed,
        texturePad = 12,
        textureScale = 1,
        renderDrawable2D,
        renderIsolated,
        onProgress,
    } = options;

    if (!projector.isSupported()) {
        throw new Error('WebGPU projection is not available; Live2D build requires it.');
    }

    const { meshes, resolution, resolvedDefinitions } = resolveBakeTargets(parts);
    if (!resolution.mesh || resolvedDefinitions.length === 0) {
        throw new Error('No skinned mesh with face parameters found.');
    }

    let drawables: ReturnType<typeof decomposeDrawables> = [];
    const bakedTextures = new Map<string, { texture: Live2dTexture; cropX: number; cropY: number }>();

    const samples = await collectBakeSamples({
        root,
        parts,
        camera,
        projector,
        viewport,
        comboCount,
        seed,
        definitions: resolvedDefinitions,
        params: resolution.params,
        mesh: resolution.mesh,
        meshes,
        onProgress: (done, total, detail) => onProgress?.('samples', done, total, detail),
        onNeutral: async (neutralCamera, neutralSamples) => {
            const neutral = neutralSamples.find((sample) => sample.kind === 'neutral');
            if (!neutral) {
                return;
            }
            const bundleForDecomposition: BakeBundle = {
                schemaVersion: 1,
                createdAt: '',
                modelName,
                params: [],
                parts: bakePartsFromSources(parts),
                samples: neutralSamples,
            };
            drawables = decomposeDrawables(bundleForDecomposition);

            const textureViewport = {
                width: Math.round(viewport.width * textureScale),
                height: Math.round(viewport.height * textureScale),
            };
            for (let index = 0; index < drawables.length; index += 1) {
                const drawable = drawables[index];
                onProgress?.('textures', index, drawables.length, drawable.label);
                const composed = renderDrawable2D
                    ? await renderDrawable2D(drawable.leafIds, neutralCamera, textureViewport)
                    : null;
                const render = composed ?? renderIsolated(drawable.leafIds, neutralCamera, textureViewport);
                const neutralBounds = drawableBoundsAtNeutral(drawable, neutral);
                const bounds = {
                    minX: neutralBounds.minX * textureScale,
                    minY: neutralBounds.minY * textureScale,
                    maxX: neutralBounds.maxX * textureScale,
                    maxY: neutralBounds.maxY * textureScale,
                };
                const cropped = cropTopDown(render, bounds, texturePad * textureScale, textureViewport);
                bakedTextures.set(drawable.id, cropped);
            }
            onProgress?.('textures', drawables.length, drawables.length, 'done');
        },
    });

    const bundle: BakeBundle = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        modelName,
        params: resolution.params,
        parts: bakePartsFromSources(parts),
        samples,
    };
    const neutral = samples.find((sample) => sample.kind === 'neutral');
    if (!neutral) {
        throw new Error('Bake produced no neutral sample.');
    }

    const families = buildFamilyKeyforms(bundle, drawables);
    const depthFamilies = buildDepthKeyforms(bundle, drawables);
    const neutralPositions = drawables.map((drawable) => drawableNeutralPositions(drawable, neutral));
    const neutralMedians = drawables.map((drawable) => medianDepth(drawable, neutral));
    const orderIds = computeDrawOrder(drawables, neutral);
    const poseDrawOrders = computePoseDrawOrders(
        drawables,
        orderIds.map((id) => drawables.findIndex((drawable) => drawable.id === id)),
        bundle.samples
            .filter((sample) => sample.kind === 'family-sweep' && sample.family)
            .map((sample) => ({ family: sample.family as string, sample })),
        viewport,
        drawables.map((drawable) => /髪|Hair|hair/.test(drawable.label)),
    );
    const orderIndexById = new Map(orderIds.map((id, index) => [id, index]));

    const evaluator = createPoseEvaluator(drawables, neutralPositions, families);
    const errorReport = evaluateComboError(bundle, drawables, evaluator);
    const orderReport = checkOrderConsistency(bundle, drawables, orderIds);

    const live2dDrawables: Live2dDrawable[] = drawables.map((drawable, drawableIndex) => {
        const baked = bakedTextures.get(drawable.id);
        if (!baked) {
            throw new Error(`Missing isolated texture for drawable ${drawable.id}.`);
        }
        const uvs = new Float32Array(drawable.vertexCount * 2);
        const positions = neutralPositions[drawableIndex];
        for (let v = 0; v < drawable.vertexCount; v += 1) {
            // Neutral positions are in 1x canvas pixels; the baked crop and
            // texture live in textureScale-x texels. Convert positions into
            // texel space so every term shares one unit — mixing them makes
            // every UV negative and the whole model samples the first shelf.
            uvs[v * 2] = (positions[v * 2] * textureScale - baked.cropX) / baked.texture.width;
            uvs[v * 2 + 1] =
                (positions[v * 2 + 1] * textureScale - baked.cropY) / baked.texture.height;
        }
        return {
            id: drawable.id,
            label: drawable.label,
            meshId: drawable.meshId,
            leafIds: drawable.leafIds,
            vertexCount: drawable.vertexCount,
            triangleCount: drawable.triangleCount,
            triangles: drawable.triangles,
            meshVertexIndices: drawable.meshVertexIndices,
            neutralPositions: positions,
            uvs,
            texture: baked.texture,
            renderOrder: orderIndexById.get(drawable.id) ?? drawableIndex,
            masks: mouthMaskIds(drawable.label),
        };
    });

    const model: Live2dModel = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        modelName,
        viewport: { ...viewport },
        params: resolvedDefinitions.map(({ id, label, min, max, default: defaultValue }) => ({
            id,
            label,
            min,
            max,
            default: defaultValue,
        })),
        drawables: live2dDrawables,
        families,
        depthFamilies,
        neutralDepths: neutralMedians,
        order: orderIds,
        errorReport,
        orderReport,
        textureScale,
        poseDrawOrders,
    };

    return { model, bundle };
};
