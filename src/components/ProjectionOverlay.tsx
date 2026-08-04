import { forwardRef, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import {
    collectProjectedPartShapesForGpuFrame,
    filterSmallProjectedPartShapes,
    type ProjectionMaskState,
    type ProjectionOverlaySettings,
} from '../lib/partProjection';
import { getGpuOverlayComposer } from '../lib/gpuOverlayComposer';
import { recordPerfSample } from '../lib/perfLogger';
import type { ProjectionPartSource } from '../lib/modelParts';
import { getWebGpuScreenProjector } from '../lib/webgpuScreenProjector';

export type ProjectionOverlayHandle = {
    renderFrame: (
        renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.Camera,
        root: THREE.Object3D | null,
        viewportWidth: number,
        viewportHeight: number,
        parts: ProjectionPartSource[],
        maskState: ProjectionMaskState | null,
        settings: ProjectionOverlaySettings,
        visibleLeafIds: Set<string> | null,
        frameId: number,
    ) => void;
};

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

const ProjectionOverlay = forwardRef<ProjectionOverlayHandle>(function ProjectionOverlay(_, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const gpuOverlayComposerRef = useRef(getGpuOverlayComposer());
    const queuedJobRef = useRef<RenderJob | null>(null);
    const processingRef = useRef(false);
    const droppedQueuedFramesRef = useRef(0);

    const processQueueRef = useRef<(() => Promise<void>) | null>(null);

    processQueueRef.current = async () => {
        if (processingRef.current) {
            return;
        }

        processingRef.current = true;
        try {
            while (queuedJobRef.current) {
                const canvas = canvasRef.current;
                const job = queuedJobRef.current;
                queuedJobRef.current = null;

                if (!canvas) {
                    continue;
                }

                const overlayStart = performance.now();
                const queueDelayMs = overlayStart - job.enqueuedAt;
                const gpuOverlayComposer = gpuOverlayComposerRef.current;

                if (
                    job.root === null ||
                    !job.maskState ||
                    job.viewportWidth <= 0 ||
                    job.viewportHeight <= 0
                ) {
                    await gpuOverlayComposer.clear(canvas, job.viewportWidth, job.viewportHeight);
                    continue;
                }

                if (!job.settings.enabled) {
                    await gpuOverlayComposer.clear(canvas, job.viewportWidth, job.viewportHeight);
                    continue;
                }

                const projector = getWebGpuScreenProjector();
                if (!projector.isSupported()) {
                    await gpuOverlayComposer.clear(canvas, job.viewportWidth, job.viewportHeight);
                    continue;
                }

                const waitStart = performance.now();
                const ready = await projector.waitForFrame(job.frameId);
                const waitMs = performance.now() - waitStart;
                if (!ready) {
                    continue;
                }

                const frameLookupStart = performance.now();
                const frame = projector.getFrame(job.frameId);
                const frameLookupMs = performance.now() - frameLookupStart;
                if (!frame) {
                    continue;
                }

                const collectStart = performance.now();
                const shapes = await collectProjectedPartShapesForGpuFrame(
                    job.parts,
                    job.maskState,
                    job.settings,
                    job.visibleLeafIds,
                    frame,
                );
                const collectMs = performance.now() - collectStart;
                if (!shapes) {
                    continue;
                }

                const filterStart = performance.now();
                const filteredShapes = filterSmallProjectedPartShapes(shapes);
                const filterMs = performance.now() - filterStart;

                const composeStart = performance.now();
                await gpuOverlayComposer.render(
                    canvas,
                    filteredShapes,
                    job.viewportWidth,
                    job.viewportHeight,
                    job.settings,
                );
                const composeMs = performance.now() - composeStart;
                const overlayMs = performance.now() - overlayStart;

                recordPerfSample({
                    label: 'overlay-frame',
                    values: {
                        queueDelay: queueDelayMs,
                        waitForFrame: waitMs,
                        getFrame: frameLookupMs,
                        collectShapes: collectMs,
                        filterShapes: filterMs,
                        compose: composeMs,
                        droppedQueuedFrames: droppedQueuedFramesRef.current,
                        total: overlayMs,
                    },
                });
                droppedQueuedFramesRef.current = 0;
            }
        } finally {
            processingRef.current = false;
            if (queuedJobRef.current) {
                void processQueueRef.current?.();
            }
        }
    };

    useImperativeHandle(ref, () => ({
        renderFrame: (
            _renderer,
            _scene,
            _camera,
            root,
            viewportWidth,
            viewportHeight,
            parts,
            maskState,
            settings,
            visibleLeafIds,
            frameId,
        ) => {
            const canvas = canvasRef.current;
            if (!canvas || root === null || !maskState) {
                return;
            }

            if (queuedJobRef.current) {
                droppedQueuedFramesRef.current += 1;
            }

            queuedJobRef.current = {
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

            void processQueueRef.current?.();
        },
    }));

    return <canvas ref={canvasRef} className="projection-overlay" />;
});

export default ProjectionOverlay;
