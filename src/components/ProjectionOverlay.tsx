import { forwardRef, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import type { ProjectionMaskState, ProjectionOverlaySettings } from '../lib/2DRenderShared/types';
import { OverlayRenderPipeline } from '../lib/2DRenderPipeline/overlayPipeline';
import type { ProjectionPartSource } from '../lib/modelParts';

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
    getCanvas: () => HTMLCanvasElement | null;
    waitForIdle: () => Promise<void>;
};

const ProjectionOverlay = forwardRef<ProjectionOverlayHandle>(function ProjectionOverlay(_, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayPipelineRef = useRef(new OverlayRenderPipeline());

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
            void overlayPipelineRef.current.enqueue(
                canvasRef.current,
                root,
                viewportWidth,
                viewportHeight,
                parts,
                maskState,
                settings,
                visibleLeafIds,
                frameId,
            );
        },
        getCanvas: () => canvasRef.current,
        waitForIdle: () => overlayPipelineRef.current.waitForIdle(),
    }));

    return <canvas ref={canvasRef} className="projection-overlay" />;
});

export default ProjectionOverlay;
