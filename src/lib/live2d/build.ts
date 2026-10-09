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
    type DrawableDecomposition,
} from './decomposition';
import { buildFamilyKeyforms, buildDepthKeyforms, createPoseEvaluator, evaluateComboError } from './keyforms';
import type { Live2dDrawable, Live2dModel, Live2dTexture } from './model';
import { computeDrawOrder, checkOrderConsistency, medianDepth } from './order';
import { computePoseDrawOrders } from './occlusionOrder';
import { frameGeometryToViewport } from './framing';
import { stabilizeHeadAngleKeyforms } from './headStabilization';
import { buildHeadJointKeyforms } from './headJoint';
import { buildMouthRig } from './mouthRig';
import { resolveMouthMaskIds, enforceMouthOrder } from './mouthMasks';
import { resolveEyeMaskIds } from './eyeMasks';
import { buildEyeOcclusion } from './eyeOcclusion';
import { buildHeadExpressionJoints } from './headExpressionJoints';
import {buildEyeForeground} from './eyeForeground';
import {copySourceDeformation} from './sourceDeformation';
import {extendForegroundPaint} from './foregroundPaint';
import {captureAnatomicalHeadSource,frameAnatomicalHeadSource,type AnatomicalHeadSource} from './anchoredHeadSource';
import type { ProjectionPartSource } from '../modelParts';
import type { BakeBundle, BakeSample } from './types';

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
        drawable?: DrawableDecomposition,
        neutral?: BakeSample,
    ) => Promise<IsolatedRenderResult | null>;
    renderIsolated: (
        leafIds: string[],
        camera: THREE.PerspectiveCamera,
        viewport: { width: number; height: number },
        drawable?: DrawableDecomposition,
    ) => IsolatedRenderResult;
    /** Refresh mutable scene/depth caches before each texture pass. */
    onTexturePassStart?: () => void;
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
export const PIPELINE_VERSION = '2026-10-09.23';
/** The rasterizer owns one mutable depth atlas. Consume scene textures
 * before any surface pass uploads a different atlas into that resource. */
export const texturePassOrder = (drawables: DrawableDecomposition[]) => [...drawables].sort((a,b)=>Number(!!a.surfaceTexture)-Number(!!b.surfaceTexture));

/** Resolve local layers only after their painted alpha has been inspected. */
export const finalEyeTextureLayers=(bundle:BakeBundle,candidates:DrawableDecomposition[],targets:Map<string,string[]>,paint?:Map<string,{texture:Live2dTexture;scale:number}>)=>{
    const independent=new Set<string>();
    for(const source of candidates.filter(d=>!d.surfaceTexture&&!d.maskOnly)){
        const patches=candidates.filter(d=>d.surfaceSourceId===source.id&&d.surfaceTexture&&!d.maskOnly);
        if(patches.some(d=>d.facialRole==='skin'||d.blinkSupport)||!source.rollAttachment?.every(w=>w>=.8))continue;
        const original=paint?.get(source.id);if(!original)continue;
        let alpha=0;for(let p=3;p<original.texture.rgba.length;p+=4)alpha+=original.texture.rgba[p]/255;
        // Original paint has already had blink windows cut out. Visible paint
        // outside them identifies an independent head surface such as hair.
        if(alpha/(original.scale*original.scale)<4)continue;
        independent.add(source.id);source.textureCutoutRegions=undefined;
    }
    const layers=candidates.filter(d=>!independent.has(d.surfaceSourceId??'')&&(!d.surfaceTexture||d.maskOnly||d.facialRole==='skin'||d.blinkSupport||targets.has(d.id)));
    layers.push(...buildEyeForeground(bundle,layers));
    return layers;
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
    let headSource: AnatomicalHeadSource | undefined;
    let eyeMaskTargets = new Map<string, string[]>();
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
                params: resolution.params,
                parts: bakePartsFromSources(parts, resolution.params),
                samples: neutralSamples,
            };
            drawables = decomposeDrawables(bundleForDecomposition);
            const occlusion = buildEyeOcclusion(bundleForDecomposition, drawables);
            // Keep static eye candidates through alpha analysis. Large
            // transparent supports can hide occlusion in the geometry pass.
            const configureTextures=()=>{const patchedSources=new Set(drawables.filter(d=>d.surfaceTexture&&!d.maskOnly).map(d=>d.surfaceSourceId));
            drawables.forEach(d=>{
                if(!d.surfaceTexture&&!patchedSources.has(d.id)){d.textureCutoutRegions=undefined;d.headAttachment=undefined;}
                d.textureRevealLeafIds=[...new Set(drawables.filter(other=>other.meshId===d.meshId&&other.surfaceTexture).flatMap(other=>other.leafIds))];
                d.textureRevealTriangleKeys=new Set(drawables.filter(other=>other.meshId===d.meshId&&(other.surfaceTexture||other.foregroundOnly||other.facialForeground)).flatMap(other=>Array.from({length:other.triangleCount},(_,i)=>Array.from(other.triangles.subarray(i*3,i*3+3),v=>other.meshVertexIndices[v]).join(','))));
            });};
            configureTextures();
            eyeMaskTargets = occlusion.targets;
            drawables.push(...occlusion.maskers);

            const textureViewport = {
                width: Math.round(viewport.width * textureScale),
                height: Math.round(viewport.height * textureScale),
            };
            const renderTextures=async()=>{options.onTexturePassStart?.();const textureDrawables = texturePassOrder(drawables);
            for (let index = 0; index < textureDrawables.length; index += 1) {
                const drawable = textureDrawables[index];
                if (drawable.maskOnly) {
                    bakedTextures.set(drawable.id, { texture: {width:1,height:1,rgba:new Uint8Array([255,255,255,255])},cropX:0,cropY:0 });
                    continue;
                }
                onProgress?.('textures', index, drawables.length, drawable.label);
                const composed = renderDrawable2D
                    ? await renderDrawable2D(drawable.leafIds, neutralCamera, textureViewport, drawable, neutral)
                    : null;
                const render = composed ?? renderIsolated(drawable.leafIds, neutralCamera, textureViewport, drawable);
                const neutralBounds = drawableBoundsAtNeutral(drawable, neutral);
                const bounds = {
                    minX: neutralBounds.minX * textureScale,
                    minY: neutralBounds.minY * textureScale,
                    maxX: neutralBounds.maxX * textureScale,
                    maxY: neutralBounds.maxY * textureScale,
                };
                const cropped = cropTopDown(render, bounds, texturePad * textureScale, textureViewport);
                bakedTextures.set(drawable.id, cropped);
            }};
            await renderTextures();
            const paintedOcclusion=buildEyeOcclusion(bundleForDecomposition,drawables,new Map([...bakedTextures].map(([id,value])=>[id,{...value,scale:textureScale}])));
            for(const [id,masks] of paintedOcclusion.targets)eyeMaskTargets.set(id,masks);
            for(const mask of paintedOcclusion.maskers)if(!drawables.some(d=>d.id===mask.id)){
                drawables.push(mask);bakedTextures.set(mask.id,{texture:{width:1,height:1,rgba:new Uint8Array([255,255,255,255])},cropX:0,cropY:0});
            }
            drawables=finalEyeTextureLayers(bundleForDecomposition,drawables,eyeMaskTargets,new Map([...bakedTextures].map(([id,value])=>[id,{texture:value.texture,scale:textureScale}])));
            configureTextures();
            // Candidate-only surfaces must not leave cutouts in final hair or
            // skin. Rebuild textures from the final retained layer set.
            await renderTextures();
            headSource=captureAnatomicalHeadSource(parts,neutralCamera,neutral,drawables,resolution.params);
            onProgress?.('textures', drawables.length, drawables.length, 'done');
        },
    });

    const bundle: BakeBundle = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        modelName,
        params: resolution.params,
        parts: bakePartsFromSources(parts, resolution.params),
        samples,
    };
    const neutral = samples.find((sample) => sample.kind === 'neutral');
    if (!neutral) {
        throw new Error('Bake produced no neutral sample.');
    }

    const rawFamilies = buildFamilyKeyforms(bundle, drawables);
    const depthFamilies = buildDepthKeyforms(bundle, drawables);
    const rawNeutralPositions = drawables.map((drawable) => drawableNeutralPositions(drawable, neutral));
    const mouthRig = buildMouthRig(drawables, rawNeutralPositions, rawFamilies);
    const stabilizedFamilies = stabilizeHeadAngleKeyforms(
        drawables,
        rawNeutralPositions,
        mouthRig.families,
    );
    const neutralMedians = drawables.map((drawable) => medianDepth(drawable, neutral));
    const baseOrder = enforceMouthOrder(drawables, computeDrawOrder(drawables, neutral));
    const foregroundIds=new Set(drawables.filter(d=>d.foregroundOnly||d.facialForeground).map(d=>d.id));
    const orderIds=[...baseOrder.filter(id=>!foregroundIds.has(id)),...baseOrder.filter(id=>foregroundIds.has(id))];
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

    const joints = [...buildHeadJointKeyforms(bundle, drawables, rawNeutralPositions, rawFamilies), ...mouthRig.joints, ...buildHeadExpressionJoints(drawables, rawNeutralPositions, stabilizedFamilies)];
    copySourceDeformation(drawables,stabilizedFamilies,joints);
    const evaluator = createPoseEvaluator(drawables, rawNeutralPositions, stabilizedFamilies, joints);
    const errorReport = evaluateComboError(bundle, drawables, evaluator);
    const orderReport = checkOrderConsistency(bundle, drawables, orderIds);
    const framedGeometry = frameGeometryToViewport(rawNeutralPositions, stabilizedFamilies, viewport, undefined, joints);

    const live2dDrawables: Live2dDrawable[] = drawables.map((drawable, drawableIndex) => {
        const baked = bakedTextures.get(drawable.id);
        if (!baked) {
            throw new Error(`Missing isolated texture for drawable ${drawable.id}.`);
        }
        const uvs = new Float32Array(drawable.vertexCount * 2);
        const sourcePositions = rawNeutralPositions[drawableIndex];
        const positions = framedGeometry.neutralPositions[drawableIndex];
        for (let v = 0; v < drawable.vertexCount; v += 1) {
            if(drawable.maskOnly){uvs[v*2]=.5;uvs[v*2+1]=.5;continue;}
            // Neutral positions are in 1x canvas pixels; the baked crop and
            // texture live in textureScale-x texels. Convert positions into
            // texel space so every term shares one unit — mixing them makes
            // every UV negative and the whole model samples the first shelf.
            uvs[v * 2] =
                (sourcePositions[v * 2] * textureScale - baked.cropX) / baked.texture.width;
            uvs[v * 2 + 1] =
                (sourcePositions[v * 2 + 1] * textureScale - baked.cropY) / baked.texture.height;
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
            maskOnly: drawable.maskOnly,
            alphaCorrectFiltering: drawable.surfaceTexture || drawable.foregroundOnly,
            maskIds: eyeMaskTargets.get(drawable.id) ?? resolveMouthMaskIds(drawable, drawables) ?? (drawable.facialRole ? undefined : resolveEyeMaskIds(drawable, drawables)),
            invertedMask: !!(eyeMaskTargets.get(drawable.id) ?? resolveMouthMaskIds(drawable, drawables) ?? (drawable.facialRole ? undefined : resolveEyeMaskIds(drawable, drawables))),
        };
    });

    extendForegroundPaint(live2dDrawables,drawables);
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
        families: framedGeometry.families,
        jointKeyforms: framedGeometry.jointKeyforms,
        depthFamilies,
        neutralDepths: neutralMedians,
        order: orderIds,
        errorReport,
        orderReport,
        textureScale,
        poseDrawOrders,
    };

    if(headSource){
        model.headRig=frameAnatomicalHeadSource(headSource,drawables,framedGeometry.transform);
        const headIds=['ParamAngleX','ParamAngleY','ParamAngleZ'];
        model.params=model.params.map(p=>headIds.includes(p.id)?{...p,min:-15,max:15}:p);
        model.jointKeyforms=(model.jointKeyforms??[]).filter(j=>!headIds.includes(j.x.family)&&!headIds.includes(j.y.family));
    }

    return { model, bundle };
};
