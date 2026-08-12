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

export class OverlayRenderPipeline {
    private queuedJob: RenderJob | null = null;
    private processing = false;
    private droppedQueuedFrames = 0;
    private readonly shapeTrackState = new ShapeTrackState();

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
                const projectionResult = await shapeProjectedParts(
                    job.parts,
                    job.maskState,
                    job.settings,
                    job.visibleLeafIds,
                    frame,
                );
                const shapingMs = performance.now() - shapingStart;
                if (!projectionResult) {
                    continue;
                }

                const compositionStart = performance.now();
                const composedShapes = composeProjectedShapes(
                    projectionResult.shapes,
                    job.maskState.sharedChains,
                    job.settings,
                    job.viewportWidth,
                    job.viewportHeight,
                );
                const compositionMs = performance.now() - compositionStart;

                const stableStart = performance.now();
                const stabilizedShapes = this.shapeTrackState.stabilize(
                    composedShapes,
                    job.settings,
                    job.frameId,
                    job.viewportWidth,
                    job.viewportHeight,
                );
                const stabilizeMs = performance.now() - stableStart;

                const filterStart = performance.now();
                const modeDefaults = getStyleModeDefaults(job.settings.styleMode);
                const filteredShapes = filterSmallProjectedPartShapes(
                    stabilizedShapes,
                    job.settings.minShapeArea * modeDefaults.minShapeAreaScale,
                    // The focal area is the recognition anchor.  Keep its
                    // loops through the final pass; the earlier assembler is
                    // already responsible for removing degenerate triangles.
                    // Filtering it here was the last way for eyes/mouth/face
                    // islands to vanish after visibility had been resolved.
                    { focal: 0.05, support: 1, abstract: 1.65 },
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
                        composeShapes: compositionMs,
                        stabilizeShapes: stabilizeMs,
                        filterShapes: filterMs,
                        compose: composeMs,
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
            }
        }
    }
}
