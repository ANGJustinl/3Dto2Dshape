import { forwardRef, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import {
    collectProjectedPartShapesForGpuFrame,
    filterSmallProjectedPartShapes,
    type ProjectionMaskState,
    type ProjectionOverlaySettings,
} from '../lib/partProjection';
import { getGpuOverlayComposer } from '../lib/gpuOverlayComposer';
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

const ProjectionOverlay = forwardRef<ProjectionOverlayHandle>(function ProjectionOverlay(_, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const latestRequestIdRef = useRef(0);
    const gpuOverlayComposerRef = useRef(getGpuOverlayComposer());

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

            const gpuOverlayComposer = gpuOverlayComposerRef.current;
            if (!settings.enabled) {
                void gpuOverlayComposer.clear(canvas, viewportWidth, viewportHeight);
                return;
            }

            const projector = getWebGpuScreenProjector();
            if (!projector.isSupported()) {
                void gpuOverlayComposer.clear(canvas, viewportWidth, viewportHeight);
                return;
            }

            latestRequestIdRef.current += 1;
            const requestId = latestRequestIdRef.current;
            void (async () => {
                const ready = await projector.waitForFrame(frameId);
                if (!ready || latestRequestIdRef.current !== requestId) {
                    return;
                }

                const frame = projector.getFrame(frameId);
                if (!frame) {
                    return;
                }

                const shapes = await collectProjectedPartShapesForGpuFrame(
                    parts,
                    maskState,
                    settings,
                    visibleLeafIds,
                    frame,
                );
                if (!shapes || latestRequestIdRef.current !== requestId) {
                    return;
                }

                void gpuOverlayComposer.render(
                    canvas,
                    filterSmallProjectedPartShapes(shapes),
                    viewportWidth,
                    viewportHeight,
                    settings,
                );
            })();
        },
    }));

    return <canvas ref={canvasRef} className="projection-overlay" />;
});

export default ProjectionOverlay;
