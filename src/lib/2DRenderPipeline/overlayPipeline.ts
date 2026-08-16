import * as THREE from 'three';
import type { ProjectionPartSource } from '../modelParts';
import { recordPerfSample } from '../perfLogger';
import type { ProjectionMaskState, ProjectionOverlaySettings } from '../2DRenderShared/types';
import { clear2DRenderComposition, compose2DRenderOverlay } from '../2DRenderStages/composition';
import { getWebGpuScreenProjector } from '../2DRenderStages/meshProjection/projector';
import { filterSmallProjectedPartShapes } from '../2DRenderStages/partFiltering';
import { shapeProjectedParts } from '../2DRenderStages/partShaping';
import { composeProjectedShapes } from '../2DRenderStages/partShaping/shapeComposition';
import { ShapeTrackState } from './shapeTracking';
import { getStyleModeDefaults } from '../2DRenderShared/focusResolver';

type RenderJob = {
    root: THREE.Object3D | null;
    viewportWidth: number;
    viewportHeight: number;
    parts: ProjectionPartSource[];
    maskState: ProjectionMaskState | null;
    settings: ProjectionOverlaySettings;
    visibleLeafIds: Set<string> | null;
    frameId: number;
    enqueuedAt: number;
};

type ProjectionResult = NonNullable<Awaited<ReturnType<typeof shapeProjectedParts>>>;

type ProjectionCacheEntry = {
    frameId: number;
    viewportWidth: number;
    viewportHeight: number;
    parts: ProjectionPartSource[];
    maskState: ProjectionMaskState;
    visibleLeafIds: Set<string> | null;
    geometrySignature: string;
    result: ProjectionResult;
};

const getProjectionGeometrySignature = (settings: ProjectionOverlaySettings) =>
    JSON.stringify({
        styleMode: settings.styleMode,
        simplifyEpsilon: settings.simplifyEpsilon,
        shadowStrength: settings.shadowStrength,
        highlightStrength: settings.highlightStrength,
        shadowThreshold: settings.shadowThreshold,
        highlightThreshold: settings.highlightThreshold,
        lightDirection: settings.lightDirection,
        minTriangleCount: settings.minTriangleCount,
        enableComposition: settings.enableComposition,
        enableShapeTracking: settings.enableShapeTracking,
        enableEdgeDistortion: settings.enableEdgeDistortion,
        compositionMode: settings.compositionMode,
        boundaryGuard: settings.boundaryGuard,
        depthMergeThreshold: settings.depthMergeThreshold,
        normalMergeThreshold: settings.normalMergeThreshold,
        gapMergeThreshold: settings.gapMergeThreshold,
        partOverrides: settings.partOverrides,
        cpuRasterBackend: settings.cpuRasterBackend ?? 'ts',
    });

const restyleProjectionResult = (
    result: ProjectionResult,
    settings: ProjectionOverlaySettings,
): ProjectionResult => ({
    ...result,
    shapes: result.shapes.map((shape) => {
        const focusLevel = shape.focusLevel;
        const edgeMode = focusLevel === 'focal'
            ? 'hard'
            : settings.edgeSmoothing;
        return {
            ...shape,
            edgeProfile: {
                ...shape.edgeProfile,
                mode: edgeMode,
                hardness: focusLevel === 'focal' ? 0.95 : focusLevel === 'abstract' ? 0.3 : 0.62,
                openness: edgeMode === 'open' ? (focusLevel === 'abstract' ? 0.32 : 0.16) : 0,
            },
        };
    }),
});

export class OverlayRenderPipeline {
    private queuedJob: RenderJob | null = null;
    private processing = false;
    private droppedQueuedFrames = 0;
    private readonly shapeTrackState = new ShapeTrackState();
    private projectionCache: ProjectionCacheEntry | null = null;
    private idleWaiters: Array<() => void> = [];

    waitForIdle() {
        if (!this.processing && this.queuedJob === null) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    async enqueue(
        canvas: HTMLCanvasElement | null,
        root: THREE.Object3D | null,
        viewportWidth: number,
        viewportHeight: number,
        parts: ProjectionPartSource[],
        maskState: ProjectionMaskState | null,
        settings: ProjectionOverlaySettings,
        visibleLeafIds: Set<string> | null,
        frameId: number,
    ) {
        if (!canvas || root === null || !maskState) {
            return;
        }

        if (this.queuedJob) {
            this.droppedQueuedFrames += 1;
        }

        this.queuedJob = {
            root,
            viewportWidth,
            viewportHeight,
            parts,
            maskState,
            settings,
            visibleLeafIds,
            frameId,
            enqueuedAt: performance.now(),
        };

        await this.processQueue(canvas);
    }

    private async processQueue(canvas: HTMLCanvasElement) {
        if (this.processing) {
            return;
        }

        this.processing = true;
        try {
            while (this.queuedJob) {
                const job = this.queuedJob;
                this.queuedJob = null;

                const overlayStart = performance.now();
                const queueDelayMs = overlayStart - job.enqueuedAt;

                if (
                    job.root === null ||
                    !job.maskState ||
                    job.viewportWidth <= 0 ||
                    job.viewportHeight <= 0 ||
                    !job.settings.enabled
                ) {
                    await clear2DRenderComposition(
                        canvas,
                        job.viewportWidth,
                        job.viewportHeight,
                        job.settings,
                    );
                    continue;
                }

                const meshProjectionStage = getWebGpuScreenProjector();
                if (!meshProjectionStage.isSupported()) {
                    await clear2DRenderComposition(
                        canvas,
                        job.viewportWidth,
                        job.viewportHeight,
                        job.settings,
                    );
                    continue;
                }

                const waitStart = performance.now();
                const ready = await meshProjectionStage.waitForFrame(job.frameId);
                const waitMs = performance.now() - waitStart;
                if (!ready) {
                    continue;
                }

                const frameLookupStart = performance.now();
                const frame = meshProjectionStage.getFrame(job.frameId);
                const frameLookupMs = performance.now() - frameLookupStart;
                if (!frame) {
                    continue;
                }

                const shapingStart = performance.now();
                const geometrySignature = getProjectionGeometrySignature(job.settings);
                const canReuseProjection =
                    !job.settings.enableComposition &&
                    !job.settings.enableShapeTracking &&
                    !job.settings.enableEdgeDistortion &&
                    this.projectionCache !== null &&
                    this.projectionCache.frameId === job.frameId &&
                    this.projectionCache.viewportWidth === job.viewportWidth &&
                    this.projectionCache.viewportHeight === job.viewportHeight &&
                    this.projectionCache.parts === job.parts &&
                    this.projectionCache.maskState === job.maskState &&
                    this.projectionCache.visibleLeafIds === job.visibleLeafIds &&
                    this.projectionCache.geometrySignature === geometrySignature;
                const projectionResult = canReuseProjection
                    ? restyleProjectionResult(this.projectionCache!.result, job.settings)
                    : await shapeProjectedParts(
                          job.parts,
                          job.maskState,
                          job.settings,
                          job.visibleLeafIds,
                          frame,
                      );
                const shapingMs = performance.now() - shapingStart;
                if (!projectionResult) {
                    await clear2DRenderComposition(
                        canvas,
                        job.viewportWidth,
                        job.viewportHeight,
                        job.settings,
                    );
                    continue;
                }
                if (!canReuseProjection) {
                    this.projectionCache = {
                        frameId: job.frameId,
                        viewportWidth: job.viewportWidth,
                        viewportHeight: job.viewportHeight,
                        parts: job.parts,
                        maskState: job.maskState,
                        visibleLeafIds: job.visibleLeafIds,
                        geometrySignature,
                        result: projectionResult,
                    };
                }

                const compositionStart = performance.now();
                const composedShapes = job.settings.enableComposition
                    ? composeProjectedShapes(
                          projectionResult.shapes,
                          job.maskState.sharedChains,
                          job.settings,
                          job.viewportWidth,
                          job.viewportHeight,
                      )
                    : projectionResult.shapes;
                const compositionMs = job.settings.enableComposition ? performance.now() - compositionStart : 0;

                const stableStart = performance.now();
                const stabilizedShapes = job.settings.enableShapeTracking
                    ? this.shapeTrackState.stabilize(
                          composedShapes,
                          job.settings,
                          job.frameId,
                          job.viewportWidth,
                          job.viewportHeight,
                      )
                    : composedShapes;
                const stabilizeMs = job.settings.enableShapeTracking ? performance.now() - stableStart : 0;

                const filterStart = performance.now();
                const modeDefaults = getStyleModeDefaults(job.settings.styleMode);
                const filteredShapes = filterSmallProjectedPartShapes(
                    stabilizedShapes,
                    job.settings.enableComposition
                        ? job.settings.minShapeArea * modeDefaults.minShapeAreaScale
                        : job.settings.minShapeArea,
                    job.settings.enableComposition
                        ? { focal: 0.05, support: 1, abstract: 1.65 }
                        : {},
                    job.settings.enableComposition,
                );
                const filterMs = performance.now() - filterStart;

                const composeStart = performance.now();
                await compose2DRenderOverlay(
                    canvas,
                    filteredShapes,
                    job.viewportWidth,
                    job.viewportHeight,
                    job.settings,
                    projectionResult.depthAtlas,
                );
                const composeMs = performance.now() - composeStart;
                const overlayMs = performance.now() - overlayStart;

                recordPerfSample({
                    label: 'overlay-frame',
                    values: {
                        queueDelay: queueDelayMs,
                        waitForFrame: waitMs,
                        getFrame: frameLookupMs,
                        shapeParts: shapingMs,
                        projectionCacheHit: canReuseProjection ? 1 : 0,
                        composeShapes: compositionMs,
                        stabilizeShapes: stabilizeMs,
                        filterShapes: filterMs,
                        compose: composeMs,
                        compositionEnabled: job.settings.enableComposition ? 1 : 0,
                        trackingEnabled: job.settings.enableShapeTracking ? 1 : 0,
                        edgeDistortionEnabled: job.settings.enableEdgeDistortion ? 1 : 0,
                        cpuRasterBackend: job.settings.cpuRasterBackend === 'wasm' ? 1 : job.settings.cpuRasterBackend === 'auto' ? 2 : 0,
                        shapeCount: filteredShapes.length,
                        droppedQueuedFrames: this.droppedQueuedFrames,
                        total: overlayMs,
                    },
                });
                this.droppedQueuedFrames = 0;
            }
        } finally {
            this.processing = false;
            if (this.queuedJob) {
                await this.processQueue(canvas);
            } else {
                const waiters = this.idleWaiters.splice(0);
                waiters.forEach((resolve) => resolve());
            }
        }
    }
}
