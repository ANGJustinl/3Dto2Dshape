import { forwardRef, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import {
    collectProjectedPartShapes,
    collectProjectedPartShapesForGpuFrame,
    filterSmallProjectedPartShapes,
    type ProjectedPartShape,
    type ProjectionMaskState,
    type ProjectionOverlaySettings,
} from '../lib/partProjection';
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
    const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const composedCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const ensureHelperCanvas = (canvasRefValue: HTMLCanvasElement | null, width: number, height: number) => {
        const canvas = canvasRefValue ?? document.createElement('canvas');
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        return canvas;
    };

    const sampleDepthField = (
        field: ProjectedPartShape['depthField'],
        x: number,
        y: number,
    ) => {
        const localX = Math.max(0, Math.min(field.width - 1, Math.floor(x - field.offsetX)));
        const localY = Math.max(0, Math.min(field.height - 1, Math.floor(y - field.offsetY)));
        return field.values[localY * field.width + localX];
    };

    const hexToRgb = (hex: string): [number, number, number] => {
        const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
        return [
            Number.parseInt(normalized.slice(0, 2), 16),
            Number.parseInt(normalized.slice(2, 4), 16),
            Number.parseInt(normalized.slice(4, 6), 16),
        ];
    };

    const getShapeBounds = (shape: ProjectedPartShape, viewportWidth: number, viewportHeight: number) => {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        shape.loops.forEach((loop) => {
            loop.forEach((point) => {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            });
        });

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }

        const padding = Math.max(2, Math.ceil(shape.depthField.width > 0 && shape.depthField.height > 0 ? 1 : 0));
        const offsetX = Math.max(0, Math.floor(minX) - padding);
        const offsetY = Math.max(0, Math.floor(minY) - padding);
        const endX = Math.min(viewportWidth, Math.ceil(maxX) + padding);
        const endY = Math.min(viewportHeight, Math.ceil(maxY) + padding);
        const width = endX - offsetX;
        const height = endY - offsetY;
        if (width <= 0 || height <= 0) {
            return null;
        }

        return {
            offsetX,
            offsetY,
            width,
            height,
        };
    };

    const drawShapes = (
        canvas: HTMLCanvasElement,
        shapes: ReturnType<typeof collectProjectedPartShapes>,
        viewportWidth: number,
        viewportHeight: number,
        settings: ProjectionOverlaySettings,
    ) => {
        const filteredShapes = filterSmallProjectedPartShapes(shapes);
        if (filteredShapes.length === 0) {
            return false;
        }

        const pixelRatio = window.devicePixelRatio || 1;
        const context = canvas.getContext('2d');
        if (!context) {
            return false;
        }

        const targetWidth = Math.max(1, viewportWidth);
        const targetHeight = Math.max(1, viewportHeight);
        const preparedShapes = filteredShapes
            .map((shape) => ({
                shape,
                color: hexToRgb(shape.color),
                bounds: getShapeBounds(shape, targetWidth, targetHeight),
            }))
            .filter(
                (
                    preparedShape,
                ): preparedShape is {
                    shape: ProjectedPartShape;
                    color: [number, number, number];
                    bounds: { offsetX: number; offsetY: number; width: number; height: number };
                } => preparedShape.bounds !== null,
            );
        if (preparedShapes.length === 0) {
            return false;
        }

        const maxMaskWidth = preparedShapes.reduce(
            (currentMax, preparedShape) => Math.max(currentMax, preparedShape.bounds.width),
            1,
        );
        const maxMaskHeight = preparedShapes.reduce(
            (currentMax, preparedShape) => Math.max(currentMax, preparedShape.bounds.height),
            1,
        );

        maskCanvasRef.current = ensureHelperCanvas(maskCanvasRef.current, maxMaskWidth, maxMaskHeight);
        composedCanvasRef.current = ensureHelperCanvas(composedCanvasRef.current, targetWidth, targetHeight);
        const maskCanvas = maskCanvasRef.current;
        const composedCanvas = composedCanvasRef.current;
        const maskContext = maskCanvas.getContext('2d');
        const composedContext = composedCanvas.getContext('2d');
        if (!maskContext || !composedContext) {
            return false;
        }

        if (canvas.width !== Math.max(1, Math.round(viewportWidth * pixelRatio)) || canvas.height !== Math.max(1, Math.round(viewportHeight * pixelRatio))) {
            canvas.width = Math.max(1, Math.round(viewportWidth * pixelRatio));
            canvas.height = Math.max(1, Math.round(viewportHeight * pixelRatio));
        }
        canvas.style.width = `${viewportWidth}px`;
        canvas.style.height = `${viewportHeight}px`;

        const zBuffer = new Float32Array(targetWidth * targetHeight);
        zBuffer.fill(Number.POSITIVE_INFINITY);
        const ownerBuffer = new Int32Array(targetWidth * targetHeight);
        ownerBuffer.fill(-1);

        preparedShapes.forEach(({ shape, bounds }, shapeIndex) => {
            maskContext.setTransform(1, 0, 0, 1, 0, 0);
            maskContext.clearRect(0, 0, bounds.width, bounds.height);
            maskContext.fillStyle = '#ffffff';
            shape.loops.forEach((loop) => {
                maskContext.beginPath();
                maskContext.moveTo(loop[0].x - bounds.offsetX, loop[0].y - bounds.offsetY);
                for (let index = 1; index < loop.length; index += 1) {
                    maskContext.lineTo(loop[index].x - bounds.offsetX, loop[index].y - bounds.offsetY);
                }
                maskContext.closePath();
                maskContext.fill();
            });

            const maskPixels = maskContext.getImageData(0, 0, bounds.width, bounds.height).data;
            for (let localY = 0; localY < bounds.height; localY += 1) {
                for (let localX = 0; localX < bounds.width; localX += 1) {
                    const pixelOffset = (localY * bounds.width + localX) * 4 + 3;
                    if (maskPixels[pixelOffset] === 0) {
                        continue;
                    }

                    const x = bounds.offsetX + localX;
                    const y = bounds.offsetY + localY;
                    const depth = sampleDepthField(shape.depthField, x + 0.5, y + 0.5);
                    const bufferIndex = y * targetWidth + x;
                    if (depth < zBuffer[bufferIndex]) {
                        zBuffer[bufferIndex] = depth;
                        ownerBuffer[bufferIndex] = shapeIndex;
                    }
                }
            }
        });

        const composedImage = composedContext.createImageData(targetWidth, targetHeight);
        for (let y = 0; y < targetHeight; y += 1) {
            for (let x = 0; x < targetWidth; x += 1) {
                const bufferIndex = y * targetWidth + x;
                const ownerIndex = ownerBuffer[bufferIndex];
                if (ownerIndex < 0) {
                    continue;
                }

                const [red, green, blue] = preparedShapes[ownerIndex].color;
                const pixelOffset = bufferIndex * 4;
                composedImage.data[pixelOffset] = red;
                composedImage.data[pixelOffset + 1] = green;
                composedImage.data[pixelOffset + 2] = blue;
                composedImage.data[pixelOffset + 3] = 255;
            }
        }

        const strokeRadius = Math.max(1, Math.round(settings.strokeWidth));
        for (let y = 0; y < targetHeight; y += 1) {
            for (let x = 0; x < targetWidth; x += 1) {
                const bufferIndex = y * targetWidth + x;
                const ownerIndex = ownerBuffer[bufferIndex];
                if (ownerIndex < 0) {
                    continue;
                }

                const neighbors: Array<[number, number]> = [
                    [x - 1, y],
                    [x + 1, y],
                    [x, y - 1],
                    [x, y + 1],
                ];
                const isBoundary = neighbors.some(([neighborX, neighborY]) => {
                    if (
                        neighborX < 0 ||
                        neighborY < 0 ||
                        neighborX >= targetWidth ||
                        neighborY >= targetHeight
                    ) {
                        return true;
                    }
                    return ownerBuffer[neighborY * targetWidth + neighborX] !== ownerIndex;
                });
                if (!isBoundary) {
                    continue;
                }

                for (let offsetY = -strokeRadius + 1; offsetY < strokeRadius; offsetY += 1) {
                    for (let offsetX = -strokeRadius + 1; offsetX < strokeRadius; offsetX += 1) {
                        const strokeX = x + offsetX;
                        const strokeY = y + offsetY;
                        if (
                            strokeX < 0 ||
                            strokeY < 0 ||
                            strokeX >= targetWidth ||
                            strokeY >= targetHeight
                        ) {
                            continue;
                        }
                        const strokeOffset = (strokeY * targetWidth + strokeX) * 4;
                        composedImage.data[strokeOffset] = 16;
                        composedImage.data[strokeOffset + 1] = 16;
                        composedImage.data[strokeOffset + 2] = 16;
                        composedImage.data[strokeOffset + 3] = 255;
                    }
                }
            }
        }

        composedContext.putImageData(composedImage, 0, 0);
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.globalAlpha = settings.opacity;
        context.drawImage(composedCanvas, 0, 0, viewportWidth, viewportHeight);
        context.globalAlpha = 1;
        return true;
    };

    useImperativeHandle(ref, () => ({
        renderFrame: (
            renderer,
            scene,
            camera,
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

            if (!settings.enabled) {
                const context = canvas.getContext('2d');
                context?.setTransform(1, 0, 0, 1, 0, 0);
                context?.clearRect(0, 0, canvas.width, canvas.height);
                return;
            }

            const projector = getWebGpuScreenProjector();
            if (!projector.isSupported()) {
                const shapes = collectProjectedPartShapes(
                    renderer,
                    scene,
                    camera,
                    root,
                    parts,
                    maskState,
                    viewportWidth,
                    viewportHeight,
                    settings,
                    visibleLeafIds,
                    frameId,
                );
                drawShapes(canvas, shapes, viewportWidth, viewportHeight, settings);
                return;
            }

            latestRequestIdRef.current += 1;
            const requestId = latestRequestIdRef.current;
            void (async () => {
                const ready = await projector.waitForFrame(frameId);
                if (latestRequestIdRef.current !== requestId) {
                    return;
                }

                if (!ready) {
                    return;
                }

                const frame = projector.getFrame(frameId);
                if (!frame) {
                    return;
                }

                const shapes = collectProjectedPartShapesForGpuFrame(
                    renderer,
                    parts,
                    maskState,
                    settings,
                    visibleLeafIds,
                    frame,
                );
                if (!shapes) {
                    return;
                }

                drawShapes(canvas, shapes, viewportWidth, viewportHeight, settings);
            })();

        },
    }));

    return <canvas ref={canvasRef} className="projection-overlay" />;
});

export default ProjectionOverlay;
