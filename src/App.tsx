import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { frameFrontCamera } from './lib/live2d/frontCamera';
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { ensureAmmo } from './lib/ammo';
import PartPanel from './components/PartPanel';
import ProjectionOverlay, { type ProjectionOverlayHandle } from './components/ProjectionOverlay';
import {
    areModelTexturesReady,
    getTriangleSampleDebugInfo,
    splitModelParts,
    type MaterialDebugInfo,
    type PartNode,
    type ProjectionPartSource,
} from './lib/modelParts';
import {
    type ProjectionMaskState,
    type ProjectionOverlaySettings,
} from './lib/2DRenderShared/types';
import { createProjectionMaskState } from './lib/2DRenderShared/maskState';
import { createDefaultProjectionSettings } from './lib/2DRenderShared/defaultSettings';
import { projectionRasterScale } from './lib/2DRenderPipeline/temporalPaint';
import { getStyleModeDefaults } from './lib/2DRenderShared/focusResolver';
import { getWebGpuScreenProjector } from './lib/2DRenderStages/meshProjection/projector';
import { compose2DRenderOverlay } from './lib/2DRenderStages/composition';
import { filterSmallProjectedPartShapes } from './lib/2DRenderStages/partFiltering';
import { shapeProjectedParts } from './lib/2DRenderStages/partShaping';
import { composeProjectedShapes } from './lib/2DRenderStages/partShaping/shapeComposition';
import { getSharedWebGpuContext } from './lib/webgpuShared';
import { getRasterContourClient } from './lib/wasm/rasterContourClient';
import {
    exportVideo,
    type ExportFrameCanvases,
    type ExportVideoSettings,
} from './lib/export/videoExporter';
import { buildLive2dModel, type IsolatedRenderResult } from './lib/live2d/build';
import { summarizeBake, type BakeSummary } from './lib/live2d/bakeSummary';
import type { Live2dModel } from './lib/live2d/model';
import type { DrawableDecomposition } from './lib/live2d/decomposition';
import { surfaceTextureParts } from './lib/live2d/facialSurfaces';
import {paintVisibilityMask} from './lib/live2d/isolatePaint';
import type { BakeSample } from './lib/live2d/types';

type MaterialState = {
    visible: boolean;
};

type GpuStatus = 'checking' | 'ready' | 'webgpu-unavailable' | 'webgpu-error';
type AssetStatus = 'loading-model' | 'loading-textures' | 'ready' | 'model-error';
type RuntimeStatus = GpuStatus | AssetStatus | 'wasm-loading' | 'wasm-failed' | 'wasm-timed-out';

const RUNTIME_STATUS_LABELS: Record<RuntimeStatus, string> = {
    checking: 'Checking WebGPU…',
    'webgpu-unavailable': 'WebGPU is unavailable. Use a compatible browser for the 2D view.',
    'webgpu-error': 'WebGPU initialization failed. Check browser permissions or GPU support.',
    'loading-model': 'Loading PMX model…',
    'loading-textures': 'Waiting for model textures…',
    ready: 'Ready',
    'model-error': 'Model or texture loading failed. Please import the complete model folder.',
    'wasm-loading': 'Initializing CPU raster WASM…',
    'wasm-failed': 'WASM initialization failed. Choose TypeScript fallback or retry in Advanced settings.',
    'wasm-timed-out': 'WASM initialization timed out. Choose TypeScript fallback or retry in Advanced settings.',
};

const INITIAL_POSE_ANIMATION_VALUE = '__initial_pose__';
const ANIMATION_FRAME_SECONDS = 1 / 30;

type ExportFrameProvider = (frame: number) => Promise<ExportFrameCanvases>;

const VMD_ANIMATION_OPTIONS = [
    {
        label: 'Initial Pose',
        value: INITIAL_POSE_ANIMATION_VALUE,
    },
] as const;

const POSITION_KEY_EPSILON = 1e-4;

const getPositionKey = (
    positionAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    vertexIndex: number,
) => {
    const x = Math.round(positionAttribute.getX(vertexIndex) / POSITION_KEY_EPSILON);
    const y = Math.round(positionAttribute.getY(vertexIndex) / POSITION_KEY_EPSILON);
    const z = Math.round(positionAttribute.getZ(vertexIndex) / POSITION_KEY_EPSILON);
    return `${x},${y},${z}`;
};

const getIntersectionMaterialIndex = (
    geometry: THREE.BufferGeometry,
    intersection: THREE.Intersection<THREE.Object3D>,
) => {
    const faceMaterialIndex = intersection.face?.materialIndex;
    if (typeof faceMaterialIndex === 'number') {
        return faceMaterialIndex;
    }

    if (intersection.faceIndex === undefined || intersection.faceIndex === null) {
        return null;
    }

    const triangleOffset = intersection.faceIndex * 3;
    const group = geometry.groups.find(
        (candidate) => triangleOffset >= candidate.start && triangleOffset < candidate.start + candidate.count,
    );
    return group?.materialIndex ?? null;
};

const getTriangleVertexIndices = (geometry: THREE.BufferGeometry, faceIndex: number) => {
    const index = geometry.getIndex();
    if (!index) {
        return null;
    }

    const base = faceIndex * 3;
    if (base + 2 >= index.count) {
        return null;
    }

    return [
        Number(index.getX(base)),
        Number(index.getX(base + 1)),
        Number(index.getX(base + 2)),
    ] as [number, number, number];
};

const getAdjacentFaceIndices = (geometry: THREE.BufferGeometry, faceIndex: number) => {
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (!index) {
        return [];
    }

    const target = getTriangleVertexIndices(geometry, faceIndex);
    if (!target) {
        return [];
    }

    const targetEdges = new Set([
        [getPositionKey(position, target[0]), getPositionKey(position, target[1])].sort().join('|'),
        [getPositionKey(position, target[1]), getPositionKey(position, target[2])].sort().join('|'),
        [getPositionKey(position, target[2]), getPositionKey(position, target[0])].sort().join('|'),
    ]);
    const adjacent: number[] = [];

    for (let candidateFaceIndex = 0; candidateFaceIndex < index.count / 3; candidateFaceIndex += 1) {
        if (candidateFaceIndex === faceIndex) {
            continue;
        }

        const candidate = getTriangleVertexIndices(geometry, candidateFaceIndex);
        if (!candidate) {
            continue;
        }

        const candidateEdges = [
            [getPositionKey(position, candidate[0]), getPositionKey(position, candidate[1])].sort().join('|'),
            [getPositionKey(position, candidate[1]), getPositionKey(position, candidate[2])].sort().join('|'),
            [getPositionKey(position, candidate[2]), getPositionKey(position, candidate[0])].sort().join('|'),
        ];
        if (candidateEdges.some((edge) => targetEdges.has(edge))) {
            adjacent.push(candidateFaceIndex);
        }
    }

    return adjacent;
};

const getVertexWorldPosition = (
    mesh: THREE.Mesh | THREE.SkinnedMesh,
    vertexIndex: number,
    target: THREE.Vector3,
) => {
    const position = mesh.geometry.getAttribute('position');
    target.fromBufferAttribute(position, vertexIndex);

    if (mesh instanceof THREE.SkinnedMesh) {
        mesh.applyBoneTransform(vertexIndex, target);
    }

    return mesh.localToWorld(target);
};

const buildTriangleDebugLines = (
    mesh: THREE.Mesh | THREE.SkinnedMesh,
    faceIndices: number[],
) => {
    const geometry = mesh.geometry;
    const uniqueEdges = new Set<string>();
    const positions: number[] = [];
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();

    faceIndices.forEach((faceIndex) => {
        const triangle = getTriangleVertexIndices(geometry, faceIndex);
        if (!triangle) {
            return;
        }

        const edges: Array<[number, number]> = [
            [triangle[0], triangle[1]],
            [triangle[1], triangle[2]],
            [triangle[2], triangle[0]],
        ];

        edges.forEach(([left, right]) => {
            const edgeKey = `${Math.min(left, right)}-${Math.max(left, right)}`;
            if (uniqueEdges.has(edgeKey)) {
                return;
            }
            uniqueEdges.add(edgeKey);

            getVertexWorldPosition(mesh, left, start);
            getVertexWorldPosition(mesh, right, end);
            positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
        });
    });

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({
            color: 0x00ff66,
            depthTest: false,
            toneMapped: false,
        }),
    );
};

type AppProps = {
    initialModelUrl: string;
    initialModelName?: string;
    initialProjectionSettings?: Partial<ProjectionOverlaySettings>;
    initialAnimationValue?: string;
    animationOptions?: Array<{ label: string; value: string }>;
    resolveAssetUrl?: (url: string) => string;
    resolveAnimationUrl?: (path: string) => string;
    onAnimationSelection?: (path: string) => void;
    onOperationStateChange?: (busy: boolean) => void;
    assetPanel?: ReactNode;
    sourceBusy?: boolean;
};

function disposeModelResources(root: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material);
            for (const value of Object.values(material)) {
                if (value instanceof THREE.Texture) textures.add(value);
            }
        }
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    geometries.forEach((geometry) => geometry.dispose());
}

function App({
    initialModelUrl, initialModelName = 'Model', initialProjectionSettings,
    initialAnimationValue = INITIAL_POSE_ANIMATION_VALUE, animationOptions,
    resolveAssetUrl, resolveAnimationUrl, onAnimationSelection, onOperationStateChange, assetPanel, sourceBusy = false,
}: AppProps) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const resultPaneRef = useRef<HTMLDivElement | null>(null);
    const modelRef = useRef<THREE.Object3D | null>(null);
    const controlsRef = useRef<{ enabled: boolean } | null>(null);
    const projectionOverlayRef = useRef<ProjectionOverlayHandle | null>(null);
    const materialStateRef = useRef(new WeakMap<THREE.Material, MaterialState>());
    const leafMaterialMapRef = useRef(new Map<string, THREE.Material>());
    const projectionPartsRef = useRef<ProjectionPartSource[]>([]);
    const projectionMaskStateRef = useRef<ProjectionMaskState | null>(null);
    const projectionSettingsRef = useRef<ProjectionOverlaySettings>({...createDefaultProjectionSettings(),...initialProjectionSettings});
    const visibleLeafIdsRef = useRef<Set<string> | null>(null);
    const selectedAnimationRef = useRef<string>(initialAnimationValue);
    const operationBusyRef = useRef(false);
    const reloadAnimationRef = useRef<(() => void) | null>(null);
    const stepBackwardStrideFramesRef = useRef<(() => void) | null>(null);
    const stepBackwardSingleFrameRef = useRef<(() => void) | null>(null);
    const stepForwardSingleFrameRef = useRef<(() => void) | null>(null);
    const stepForwardStrideFramesRef = useRef<(() => void) | null>(null);
    const frameStrideRef = useRef(2);
    const playbackPausedRef = useRef(false);
    const forceProjectionRefreshRef = useRef(true);
    const forceNewProjectionFrameRef = useRef(false);
    const currentAnimationTimeRef = useRef(0);
    const currentAnimationDurationRef = useRef(0);
    const setAnimationTimeRef = useRef<((timeSeconds: number) => void) | null>(null);
    const exportFrameRef = useRef<ExportFrameProvider | null>(null);
    const buildLive2dRef = useRef<
        ((
            onProgress: (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void,
            textureScale: number,
        ) => Promise<{ model: Live2dModel; summary: BakeSummary }>) | null
    >(null);
    const [parts, setParts] = useState<PartNode[]>([]);
    const [debugMaterials, setDebugMaterials] = useState<MaterialDebugInfo[]>([]);
    const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
    const [projectionSettings, setProjectionSettings] = useState<ProjectionOverlaySettings>(
        projectionSettingsRef.current,
    );
    const [selectedAnimation, setSelectedAnimation] = useState<string>(
        initialAnimationValue,
    );
    const [animationFrameCount, setAnimationFrameCount] = useState(1);
    const [frameStride, setFrameStride] = useState(2);
    const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
    const [live2dModel, setLive2dModel] = useState<Live2dModel | null>(null);
    const [gpuStatus, setGpuStatus] = useState<GpuStatus>('checking');
    const [assetStatus, setAssetStatus] = useState<AssetStatus>('loading-model');
    const [assetError, setAssetError] = useState('');
    const [animationError, setAnimationError] = useState('');
    const [operationBusy, setOperationBusy] = useState(false);
    const [wasmSnapshot, setWasmSnapshot] = useState(() => getRasterContourClient().getSnapshot());

    useEffect(() => getRasterContourClient().subscribe(setWasmSnapshot), []);

    useEffect(() => {
        if ((projectionSettings.cpuRasterBackend ?? 'ts') === 'ts') {
            return;
        }
        void getRasterContourClient().initialize();
    }, [projectionSettings.cpuRasterBackend]);

    useEffect(() => {
        const context = getSharedWebGpuContext();
        if (!context.isSupported()) {
            setGpuStatus('webgpu-unavailable');
            return;
        }

        void context
            .getDevice()
            .then((device) => {
                setGpuStatus(device ? 'ready' : 'webgpu-error');
            })
            .catch(() => {
                setGpuStatus('webgpu-error');
            });
    }, []);

    useEffect(() => {
        if (projectionRasterScale(projectionSettingsRef.current) !== projectionRasterScale(projectionSettings)) {
            forceNewProjectionFrameRef.current = true;
        }
        projectionSettingsRef.current = projectionSettings;
        // A style-only change must refresh the overlay once even when the
        // model is paused. The animation loop otherwise has no scene motion
        // to use as an invalidation signal.
        forceProjectionRefreshRef.current = true;
    }, [projectionSettings]);

    useEffect(() => {
        frameStrideRef.current = frameStride;
    }, [frameStride]);

    useEffect(() => {
        playbackPausedRef.current = isPlaybackPaused;
    }, [isPlaybackPaused]);

    useEffect(() => {
        selectedAnimationRef.current = selectedAnimation;
        reloadAnimationRef.current?.();
    }, [selectedAnimation]);

    useEffect(() => {
        const materialStateMap = materialStateRef.current;
        const partById = new Map<string, PartNode>();
        const stack = [...parts];

        while (stack.length > 0) {
            const current = stack.pop()!;
            partById.set(current.id, current);
            stack.push(...current.children);
        }

        const selectedLeafIds = new Set(partById.get(selectedPartId ?? '')?.leafIds ?? []);
        visibleLeafIdsRef.current = selectedPartId === null ? null : selectedLeafIds;

        leafMaterialMapRef.current.forEach((material, leafId) => {
            const baseState = materialStateMap.get(material);
            if (!baseState) {
                return;
            }

            if (selectedPartId === null) {
                material.visible = baseState.visible;
            } else {
                material.visible = selectedLeafIds.has(leafId);
            }
            material.needsUpdate = true;
        });
    }, [parts, selectedPartId]);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) {
            return;
        }

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87ceeb);

        const camera = new THREE.PerspectiveCamera(
            35,
            mount.clientWidth / mount.clientHeight,
            0.1,
            200,
        );
        camera.position.set(0, 10, 28);

        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
        });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controlsRef.current = controls;
        controls.enableDamping = true;
        controls.dampingFactor = 0.5;
        controls.target.set(0, 10, 0);
        controls.minDistance = 8;
        controls.maxDistance = 60;
        controls.enablePan = false;

        const manager = new THREE.LoadingManager();
        const loader = new MMDLoader(manager);
        const sourceUrls = new Map<string, string>();
        if (resolveAssetUrl) {
            manager.setURLModifier((url) => {
                const resolved = resolveAssetUrl(url);
                sourceUrls.set(resolved, url);
                return resolved;
            });
        }
        const mmdHelper = new MMDAnimationHelper({
            afterglow: 0,
            resetPhysicsOnLoop: true,
        });
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        let disposed = false;
        let model: THREE.Object3D | null = null;
        let segmentationTimer: number | null = null;
        let pointerDown: { x: number; y: number; button: number } | null = null;
        let debugLineOverlay: THREE.LineSegments | null = null;
        let targetMeshForAnimation: THREE.SkinnedMesh | null = null;
        let pendingVmdAnimation: THREE.AnimationClip | null = null;
        let segmentationReady = false;
        let helperAttached = false;
        let animationLoadToken = 0;
        let assetLoadFailed = false;
        setAssetError('');
        setAnimationError('');
        setAssetStatus('loading-model');
        const failAssetLoad = (error: unknown) => {
            if (disposed) return;
            assetLoadFailed = true;
            setAssetStatus('model-error');
            setAssetError(error instanceof Error ? error.message : 'Unable to read the model or textures. Please select the complete model folder.');
        };
        manager.onError = (url) => {
            if (disposed) return;
            const original = sourceUrls.get(url) ?? url;
            if (/\.vmd$/i.test(original)) return; // The motion callback has its own error state.
            failAssetLoad(new Error(`Unable to read model or texture: ${original.replace(/^local-assets:\/\/[^/]+\//, '')}`));
        };

        const tryAttachMmdAnimation = async () => {
            if (
                disposed ||
                helperAttached ||
                !segmentationReady ||
                !targetMeshForAnimation ||
                !pendingVmdAnimation
            ) {
                return;
            }

            const targetMesh = targetMeshForAnimation;
            const animation = pendingVmdAnimation;
            const attachToken = animationLoadToken;
            helperAttached = true;
            currentAnimationTimeRef.current = 0;
            currentAnimationDurationRef.current = animation.duration;
            setAnimationFrameCount(Math.max(1, Math.ceil(animation.duration / ANIMATION_FRAME_SECONDS)));

            const mmdMeta = (
                targetMesh.geometry.userData as {
                    MMD?: {
                        rigidBodies?: unknown[];
                        constraints?: unknown[];
                        bones?: unknown[];
                    };
                }
            ).MMD;

            console.log('MMD playback setup.', {
                trackCount: animation.tracks.length,
                rigidBodyCount: mmdMeta?.rigidBodies?.length ?? 0,
                constraintCount: mmdMeta?.constraints?.length ?? 0,
                boneCount: mmdMeta?.bones?.length ?? targetMesh.skeleton.bones.length,
            });

            try {
                try {
                    mmdHelper.remove(targetMesh);
                } catch {
                    // ignore helper replacement cleanup errors
                }
                await ensureAmmo();
                if (disposed || attachToken !== animationLoadToken) {
                    return;
                }
                mmdHelper.add(targetMesh, {
                    animation,
                    physics: true,
                });
                forceProjectionRefreshRef.current = true;
                forceNewProjectionFrameRef.current = true;
                console.log('Applied VMD animation with physics.', {
                    clip: animation.name,
                    trackCount: animation.tracks.length,
                });
            } catch (error) {
                if (disposed || attachToken !== animationLoadToken) return;
                console.warn('Physics setup failed, falling back to animation only.', error);
                try {
                    mmdHelper.add(targetMesh, {
                        animation,
                        physics: false,
                    });
                    forceProjectionRefreshRef.current = true;
                    forceNewProjectionFrameRef.current = true;
                    console.log('Applied VMD animation without physics.', {
                        clip: animation.name,
                        trackCount: animation.tracks.length,
                    });
                } catch (fallbackError) {
                    helperAttached = false;
                    console.warn('Failed to apply VMD animation.', fallbackError);
                }
            }
        };

        const loadSelectedAnimation = () => {
            const targetMesh = targetMeshForAnimation;
            if (!targetMesh || disposed) {
                return;
            }

            animationLoadToken += 1;
            setAnimationError('');
            const currentToken = animationLoadToken;
            helperAttached = false;
            pendingVmdAnimation = null;
            currentAnimationTimeRef.current = 0;
            currentAnimationDurationRef.current = 0;
            setAnimationFrameCount(1);
            forceProjectionRefreshRef.current = true;
            forceNewProjectionFrameRef.current = true;

            try {
                mmdHelper.remove(targetMesh);
            } catch {
                // ignore helper cleanup errors during animation reload
            }
            targetMesh.pose();

            if (selectedAnimationRef.current === INITIAL_POSE_ANIMATION_VALUE) {
                targetMesh.pose();
                targetMesh.updateMatrixWorld(true);
                modelRef.current?.updateMatrixWorld(true);
                return;
            }

            loader.loadAnimation(
                resolveAnimationUrl?.(selectedAnimationRef.current) ?? selectedAnimationRef.current,
                targetMesh,
                (animation: THREE.AnimationClip) => {
                    if (disposed || currentToken !== animationLoadToken) {
                        return;
                    }

                    pendingVmdAnimation = animation;
                    void tryAttachMmdAnimation();
                },
                undefined,
                (error: unknown) => {
                    if (disposed || currentToken !== animationLoadToken) {
                        return;
                    }
                    setAnimationError(error instanceof Error ? `Motion loading failed: ${error.message}` : 'Motion loading failed. Please select the VMD file again.');
                    console.warn('Failed to load VMD animation.', error);
                },
            );
        };
        reloadAnimationRef.current = loadSelectedAnimation;

        const getAnimationMixer = () => {
            const targetMesh = targetMeshForAnimation;
            if (!targetMesh) {
                return null;
            }

            const helperObject = (mmdHelper.objects as Map<THREE.Object3D, { mixer?: THREE.AnimationMixer }>).get(
                targetMesh,
            );
            return helperObject?.mixer ?? null;
        };

        const setAnimationTime = (timeSeconds: number) => {
            const targetMesh = targetMeshForAnimation;
            const mixer = getAnimationMixer();
            if (!targetMesh || !mixer) {
                return;
            }

            mixer.setTime(timeSeconds);
            currentAnimationTimeRef.current = timeSeconds;
            targetMesh.updateMatrixWorld(true);
            modelRef.current?.updateMatrixWorld(true);
            forceProjectionRefreshRef.current = true;
            forceNewProjectionFrameRef.current = true;
        };

        setAnimationTimeRef.current = setAnimationTime;
        exportFrameRef.current = async (frame: number) => {
            if (!targetMeshForAnimation || currentAnimationDurationRef.current <= 0) {
                targetMeshForAnimation?.updateMatrixWorld(true);
                // Initial-pose exports still need a fresh projection request
                // when the current canvas happens to contain an older frame.
                forceProjectionRefreshRef.current = true;
                forceNewProjectionFrameRef.current = true;
            } else {
                const duration = currentAnimationDurationRef.current;
                const time = Math.min(
                    Math.max(0, frame * ANIMATION_FRAME_SECONDS),
                    Math.max(0, duration - ANIMATION_FRAME_SECONDS * 0.001),
                );
                setAnimationTime(time);
            }

            // Let the normal animation loop submit the projection request and
            // let the overlay pipeline finish the corresponding frame.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await projectionOverlayRef.current?.waitForIdle();
            return {
                overlay: projectionOverlayRef.current?.getCanvas() ?? null,
                model: renderer.domElement,
            };
        };

        const stepAnimationByFrames = (frameCount: number) => {
            if (selectedAnimationRef.current === INITIAL_POSE_ANIMATION_VALUE) {
                return;
            }

            const duration = currentAnimationDurationRef.current;
            if (duration <= 0) {
                return;
            }

            playbackPausedRef.current = true;
            setIsPlaybackPaused(true);
            const deltaSeconds = frameCount * ANIMATION_FRAME_SECONDS;
            const nextTime =
                ((currentAnimationTimeRef.current + deltaSeconds) % duration + duration) % duration;
            setAnimationTime(nextTime);
        };
        stepBackwardStrideFramesRef.current = () => stepAnimationByFrames(-frameStrideRef.current);
        stepBackwardSingleFrameRef.current = () => stepAnimationByFrames(-1);
        stepForwardSingleFrameRef.current = () => stepAnimationByFrames(1);
        stepForwardStrideFramesRef.current = () => stepAnimationByFrames(frameStrideRef.current);

        const applySegmentation = (targetModel: THREE.Object3D) => {
            const segmentation = splitModelParts(targetModel);
            leafMaterialMapRef.current = segmentation.leafMaterialMap;
            projectionPartsRef.current = segmentation.projectionParts;
            projectionMaskStateRef.current = createProjectionMaskState(
                targetModel,
                segmentation.leafMaterialMap,
                segmentation.projectionParts,
                segmentation.projectionSharedChains,
            );
            segmentation.leafMaterialMap.forEach((material) => {
                materialStateRef.current.set(material, {
                    visible: material.visible,
                });
            });
            setParts(segmentation.parts);
            setDebugMaterials(segmentation.debugMaterials);
            segmentationReady = true;
            setAssetStatus('ready');
            void tryAttachMmdAnimation();
        };

        const scheduleSegmentation = (targetModel: THREE.Object3D) => {
            if (!assetLoadFailed) setAssetStatus('loading-textures');
            const startedAt = performance.now();
            const attempt = () => {
                if (disposed || assetLoadFailed) {
                    return;
                }

                if (areModelTexturesReady(targetModel)) {
                    try { applySegmentation(targetModel); }
                    catch (error) { failAssetLoad(error); }
                    return;
                }

                if (performance.now() - startedAt > 60_000) {
                    failAssetLoad(new Error('Texture loading timed out. Make sure the selected model folder contains all textures.'));
                    return;
                }

                segmentationTimer = window.setTimeout(attempt, 120);
            };

            attempt();
        };

        loader.load(
            initialModelUrl,
            (loadedModel: THREE.Object3D) => {
                if (disposed) {
                    disposeModelResources(loadedModel);
                    return;
                }

                model = loadedModel;
                if (!assetLoadFailed) setAssetStatus('loading-textures');
                modelRef.current = loadedModel;
                const currentModel = loadedModel;
                const box = new THREE.Box3().setFromObject(currentModel);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());

                currentModel.position.sub(center);
                currentModel.position.y += size.y * 0.5;

                scene.add(currentModel);
                scheduleSegmentation(currentModel);
                controls.target.copy(frameFrontCamera(camera, currentModel));
                controls.update();

                const targetMesh = currentModel.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
                if (!targetMesh) {
                    console.warn('No skinned mesh found on PMX model for VMD playback.');
                    return;
                }
                targetMeshForAnimation = targetMesh;
                loadSelectedAnimation();
            },
            undefined,
            (error: unknown) => {
                failAssetLoad(error);
                console.error('Failed to load PMX model.', error);
            },
        );

        const onResize = () => {
            const { clientWidth, clientHeight } = mount;
            camera.aspect = clientWidth / clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(clientWidth, clientHeight);
        };

        const getLeafIdFromIntersection = (intersection: THREE.Intersection<THREE.Object3D>) => {
            const object = intersection.object as THREE.Mesh & {
                userData: {
                    partLeafIdByMaterialIndex?: string[];
                };
            };
            const leafIds = object.userData.partLeafIdByMaterialIndex;
            if (!leafIds || leafIds.length === 0) {
                return null;
            }

            const materialIndex = getIntersectionMaterialIndex(object.geometry, intersection);
            if (materialIndex === null) {
                return null;
            }

            return leafIds[materialIndex] ?? null;
        };

        const clearDebugOverlay = () => {
            if (!debugLineOverlay) {
                return;
            }
            scene.remove(debugLineOverlay);
            debugLineOverlay.geometry.dispose();
            if (Array.isArray(debugLineOverlay.material)) {
                debugLineOverlay.material.forEach((material) => material.dispose());
            } else {
                debugLineOverlay.material.dispose();
            }
            debugLineOverlay = null;
        };

        const logTriangleDebugInfo = (intersection: THREE.Intersection<THREE.Object3D>) => {
            const object = intersection.object;
            if (!(object instanceof THREE.Mesh || object instanceof THREE.SkinnedMesh)) {
                return;
            }

            if (intersection.faceIndex === undefined || intersection.faceIndex === null) {
                return;
            }

            const materialIndex = getIntersectionMaterialIndex(object.geometry, intersection);
            if (materialIndex === null) {
                return;
            }

            const material = Array.isArray(object.material) ? object.material[materialIndex] : object.material;
            if (!material) {
                return;
            }

            const vertexIndices = getTriangleVertexIndices(object.geometry, intersection.faceIndex);
            if (!vertexIndices) {
                return;
            }

            const sample = getTriangleSampleDebugInfo(object.geometry, material, vertexIndices);
            const materialWithExtras = material as THREE.Material & {
                color?: THREE.Color;
                emissive?: THREE.Color;
                specular?: THREE.Color;
                map?: THREE.Texture | null;
                alphaMap?: THREE.Texture | null;
            };

            console.groupCollapsed(`Triangle debug | face ${intersection.faceIndex}`);
            console.log('mesh', {
                name: object.name,
                uuid: object.uuid,
                type: object.type,
            });
            console.log('material', {
                index: materialIndex,
                name: material.name,
                type: material.type,
                color: materialWithExtras.color?.getHexString()?.toUpperCase() ?? null,
                emissive: materialWithExtras.emissive?.getHexString()?.toUpperCase() ?? null,
                specular: materialWithExtras.specular?.getHexString()?.toUpperCase() ?? null,
                opacity: material.opacity,
                transparent: material.transparent,
            });
            console.log('textures', {
                mapColorSpace: materialWithExtras.map?.colorSpace ?? null,
                mapFileName:
                    (
                        materialWithExtras.map as THREE.Texture & {
                            userData?: { MMD?: { mapFileName?: string } };
                        }
                    )?.userData?.MMD?.mapFileName ?? null,
                alphaMapPresent: Boolean(materialWithExtras.alphaMap),
            });
            console.log('triangle', {
                faceIndex: intersection.faceIndex,
                vertexIndices,
                uv: sample.uv,
                materialColor: sample.materialColor,
                textureColor: sample.textureColor,
                finalColor: sample.finalColor,
                visibleColorOnBlack: sample.visibleColorOnBlack,
            });
            console.groupEnd();
        };

        const onPointerDown = (event: PointerEvent) => {
            pointerDown = {
                x: event.clientX,
                y: event.clientY,
                button: event.button,
            };
        };

        const onPointerUp = (event: PointerEvent) => {
            if (!pointerDown || !modelRef.current) {
                pointerDown = null;
                return;
            }

            const downState = pointerDown;
            pointerDown = null;
            const moved = Math.hypot(event.clientX - downState.x, event.clientY - downState.y);
            if (moved > 4 || event.button !== downState.button) {
                return;
            }

            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const intersections = raycaster.intersectObject(modelRef.current, true);
            const hit = intersections.find(
                (intersection) => intersection.object instanceof THREE.Mesh || intersection.object instanceof THREE.SkinnedMesh,
            );
            if (!hit) {
                if (event.button === 2) {
                    clearDebugOverlay();
                }
                return;
            }

            if (event.button === 0) {
                const leafId = getLeafIdFromIntersection(hit);
                if (leafId) {
                    setSelectedPartId(leafId);
                }
                return;
            }

            if (event.button !== 2 || hit.faceIndex === undefined || hit.faceIndex === null) {
                return;
            }

            const object = hit.object;
            if (!(object instanceof THREE.Mesh || object instanceof THREE.SkinnedMesh)) {
                return;
            }

            clearDebugOverlay();
            const adjacentFaceIndices = getAdjacentFaceIndices(object.geometry, hit.faceIndex);
            debugLineOverlay = buildTriangleDebugLines(object, [hit.faceIndex, ...adjacentFaceIndices]);
            scene.add(debugLineOverlay);
            logTriangleDebugInfo(hit);
        };

        const onContextMenu = (event: MouseEvent) => {
            event.preventDefault();
        };

        const clock = new THREE.Clock();
        const webGpuProjector = getWebGpuScreenProjector();
        let projectionFrameId = 0;
        let submittedProjectionTick = -1;
        let lastSubmittedProjectionFrameId = -1;
        const animate = () => {
            if (disposed) {
                return;
            }

            requestAnimationFrame(animate);
            const delta = clock.getDelta();
            if (!playbackPausedRef.current) {
                mmdHelper.update(delta);
                if (currentAnimationDurationRef.current > 0) {
                    currentAnimationTimeRef.current =
                        ((currentAnimationTimeRef.current + delta) % currentAnimationDurationRef.current +
                            currentAnimationDurationRef.current) %
                        currentAnimationDurationRef.current;
                }
            }
            if (!playbackPausedRef.current && model && 'update' in model && typeof model.update === 'function') {
                model.update(delta);
            }
            const controlsChanged = operationBusyRef.current ? false : controls.update();
            renderer.render(scene, camera);
            const resultPane = resultPaneRef.current;
            const resultWidth = resultPane?.clientWidth ?? 0;
            const resultHeight = resultPane?.clientHeight ?? 0;
            projectionFrameId += 1;
            const currentStride = Math.max(1, Math.floor(frameStrideRef.current));
            const projectionTick = Math.floor((projectionFrameId - 1) / currentStride);
            const shouldSubmitProjection =
                (!playbackPausedRef.current && projectionTick !== submittedProjectionTick) ||
                controlsChanged ||
                forceProjectionRefreshRef.current;

            if (shouldSubmitProjection && projectionMaskStateRef.current) {
                const forceNewProjectionFrame = forceNewProjectionFrameRef.current;
                const reuseProjectionFrame =
                    playbackPausedRef.current &&
                    !controlsChanged &&
                    forceProjectionRefreshRef.current &&
                    !forceNewProjectionFrame &&
                    lastSubmittedProjectionFrameId >= 0;
                const renderFrameId = reuseProjectionFrame
                    ? lastSubmittedProjectionFrameId
                    : webGpuProjector.allocateFrameId();
                submittedProjectionTick = projectionTick;
                forceProjectionRefreshRef.current = false;
                forceNewProjectionFrameRef.current = false;
                if (!reuseProjectionFrame) {
                    lastSubmittedProjectionFrameId = renderFrameId;
                    webGpuProjector.requestFrame(
                        projectionPartsRef.current,
                        camera,
                        resultWidth * projectionRasterScale(projectionSettingsRef.current),
                        resultHeight * projectionRasterScale(projectionSettingsRef.current),
                        renderFrameId,
                        undefined,
                        projectionSettingsRef.current.useAuthoredNormals,
                    );
                }
                projectionOverlayRef.current?.renderFrame(
                    renderer,
                    scene,
                    camera,
                    modelRef.current,
                    resultWidth,
                    resultHeight,
                    projectionPartsRef.current,
                    projectionMaskStateRef.current,
                    projectionSettingsRef.current,
                    visibleLeafIdsRef.current,
                    renderFrameId,
                );
            }
        };

        window.addEventListener('resize', onResize);
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('contextmenu', onContextMenu);
        animate();

        // Live2D build (M1-M3): face bake + isolated texture renders while
        // playback is paused. renderIsolated renders only the given leaves to
        // an offscreen target with the bake camera; the animate loop cannot
        // interleave because each call is synchronous.
        buildLive2dRef.current = async (onProgress, textureScale = 2) => {
            const root = modelRef.current;
            const bakeParts = projectionPartsRef.current;
            const maskState = projectionMaskStateRef.current;
            if (!root || bakeParts.length === 0 || !maskState) {
                throw new Error('Model segmentation is not ready yet.');
            }

            // 3渲2 texture source: run the stylized 2D pipeline per drawable
            // (paint layers + contours, matching the right-hand 2D view) on a
            // transparent background. One shared neutral projection frame
            // serves every drawable; falls back to the raw 3D isolated render
            // when the 2D pipeline is unavailable.
            let neutralFrame: Awaited<ReturnType<typeof webGpuProjector.getFrame>> = null;
            let neutralShaped: Awaited<ReturnType<typeof shapeProjectedParts>> = null;
            let textureFrameId = webGpuProjector.allocateFrameId();
            const renderDrawable2D = async (
                leafIds: string[],
                isoCamera: THREE.PerspectiveCamera,
                viewport: { width: number; height: number },
                drawable?: DrawableDecomposition,
                neutral?: BakeSample,
            ): Promise<IsolatedRenderResult | null> => {
                try {
                    if (!neutralFrame) {
                        webGpuProjector.requestFrame(bakeParts, isoCamera, viewport.width, viewport.height, textureFrameId, undefined, true);
                        const ready = await webGpuProjector.waitForFrame(textureFrameId);
                        if (!ready) {
                            return null;
                        }
                        neutralFrame = webGpuProjector.getFrame(textureFrameId);
                        if (!neutralFrame) {
                            return null;
                        }
                    }

                    const settings = { ...projectionSettingsRef.current };
                    const surfaceParts = drawable?.surfaceTexture && neutral ? surfaceTextureParts(bakeParts, drawable, neutral, viewport.width/neutral.viewport.width) : null;
                    const shaped = surfaceParts ? await shapeProjectedParts(
                        surfaceParts,
                        maskState,
                        settings,
                        null,
                        neutralFrame,
                    ) : neutralShaped ?? await shapeProjectedParts(bakeParts, maskState, settings, null, neutralFrame);
                    if (!shaped) return null;
                    if (!surfaceParts) neutralShaped = shaped;
                    const selectedShapes = shaped.shapes.filter(s=>leafIds.includes(s.sourceLeafId));
                    if (!selectedShapes.length) return {rgba:new Uint8Array(viewport.width*viewport.height*4),width:viewport.width,height:viewport.height};

                    const composedShapes = settings.enableComposition
                        ? composeProjectedShapes(
                              selectedShapes,
                              maskState.sharedChains,
                              settings,
                              viewport.width,
                              viewport.height,
                          )
                        : selectedShapes;
                    const modeDefaults = getStyleModeDefaults(settings.styleMode);
                    const filteredShapes = filterSmallProjectedPartShapes(
                        composedShapes,
                        surfaceParts ? 0 : settings.minShapeArea * modeDefaults.minShapeAreaScale,
                        settings.enableComposition ? { focal: 0.05, support: 1, abstract: 1.65 } : {},
                        settings.enableComposition,
                    );
                    if (filteredShapes.length === 0) {
                        return {rgba:new Uint8Array(viewport.width*viewport.height*4),width:viewport.width,height:viewport.height};
                    }

                    const offscreen = document.createElement('canvas');
                    const composed = await compose2DRenderOverlay(
                        offscreen,
                        filteredShapes,
                        viewport.width,
                        viewport.height,
                        settings,
                        shaped.depthAtlas,
                        { transparent: true },
                    );
                    if (!composed) {
                        return null;
                    }

                    // Read back at viewport scale and flip to bottom-up rows,
                    // matching the raw renderIsolated contract.
                    const readCanvas = document.createElement('canvas');
                    readCanvas.width = viewport.width;
                    readCanvas.height = viewport.height;
                    const context = readCanvas.getContext('2d');
                    if (!context) {
                        return null;
                    }
                    context.drawImage(offscreen, 0, 0, viewport.width, viewport.height);
                    const data = context.getImageData(0, 0, viewport.width, viewport.height).data;
                    const visibilityCanvas=document.createElement('canvas');
                    const maskSettings={...settings,showContours:false,shadowStrength:0,highlightStrength:0,opacity:1};
                    await compose2DRenderOverlay(visibilityCanvas,paintVisibilityMask(shaped.shapes,new Set(leafIds)),viewport.width,viewport.height,maskSettings,shaped.depthAtlas,{transparent:true});
                    context.clearRect(0,0,viewport.width,viewport.height);
                    context.drawImage(visibilityCanvas,0,0,viewport.width,viewport.height);
                    const visibility=context.getImageData(0,0,viewport.width,viewport.height).data;
                    for(let p=0;p<data.length;p+=4)data[p+3]=Math.round(data[p+3]*(visibility[p+3]>0?visibility[p]/255:0));
                    // Eye surfaces get complete local paint; the original layer
                    // retains its established appearance everywhere else.
                    const overlay=drawable?.surfaceTexture||drawable?.foregroundOnly;
                    const regions=overlay?drawable?.textureRevealRegions:drawable?.textureCutoutRegions;
                    if(regions?.length&&neutral){
                        const scale=viewport.width/neutral.viewport.width;
                        for(let y=0;y<viewport.height;y++)for(let x=0;x<viewport.width;x++){
                            const bleed=overlay?2:0;
                            const inside=regions.some(r=>x>=r.x0*scale-bleed&&x<r.x1*scale+bleed&&y>=r.y0*scale-bleed&&y<r.y1*scale+bleed);
                            const covered=!drawable?.textureCoverage||drawable.textureCoverage[Math.floor(y/scale)*neutral.viewport.width+Math.floor(x/scale)];
                            if(overlay?(!inside||!covered):inside){const p=(y*viewport.width+x)*4;data[p]=data[p+1]=data[p+2]=data[p+3]=0;}
                        }
                    }
                    const rgba = new Uint8Array(data.length);
                    const rowBytes = viewport.width * 4;
                    for (let row = 0; row < viewport.height; row += 1) {
                        const sourceRow = viewport.height - 1 - row;
                        rgba.set(data.subarray(sourceRow * rowBytes, sourceRow * rowBytes + rowBytes), row * rowBytes);
                    }
                    return { rgba, width: viewport.width, height: viewport.height };
                } catch (error) {
                    console.warn('2D pipeline texture render failed, falling back to raw render.', error);
                    return null;
                }
            };

            const renderIsolated = (
                leafIds: string[],
                isoCamera: THREE.PerspectiveCamera,
                viewport: { width: number; height: number },
            ): IsolatedRenderResult => {
                const leafIdSet = new Set(leafIds);
                const renderTarget = new THREE.WebGLRenderTarget(viewport.width, viewport.height, {
                    depthBuffer: true,
                    stencilBuffer: false,
                });
                const materialVisibility = new Map<THREE.Material, boolean>();
                leafMaterialMapRef.current.forEach((material, leafId) => {
                    materialVisibility.set(material, material.visible);
                    material.visible = leafIdSet.has(leafId);
                });
                const previousBackground = scene.background;
                const previousClearAlpha = renderer.getClearAlpha();
                scene.background = null;
                renderer.setRenderTarget(renderTarget);
                renderer.setClearColor(0x000000, 0);
                renderer.clear();
                renderer.render(scene, isoCamera);
                const rgba = new Uint8Array(viewport.width * viewport.height * 4);
                renderer.readRenderTargetPixels(renderTarget, 0, 0, viewport.width, viewport.height, rgba);
                renderer.setRenderTarget(null);
                scene.background = previousBackground;
                renderer.setClearAlpha(previousClearAlpha);
                materialVisibility.forEach((visible, material) => {
                    material.visible = visible;
                });
                renderTarget.dispose();
                return { rgba, width: viewport.width, height: viewport.height };
            };

            const previousPaused = playbackPausedRef.current;
            playbackPausedRef.current = true;
            setIsPlaybackPaused(true);
            forceProjectionRefreshRef.current = false;
            forceNewProjectionFrameRef.current = false;
            try {
                const { model: builtModel, bundle } = await buildLive2dModel({
                    root,
                    parts: bakeParts,
                    camera,
                    projector: webGpuProjector,
                    modelName: initialModelName,
                    renderDrawable2D,
                    onTexturePassStart:()=>{neutralFrame=null;neutralShaped=null;textureFrameId=webGpuProjector.allocateFrameId();},
                    renderIsolated,
                    onProgress,
                    textureScale,
                });
                console.log('Live2D model built.', {
                    drawables: builtModel.drawables.length,
                    order: builtModel.order,
                    errorReport: builtModel.errorReport,
                    orderFlips: builtModel.orderReport.flips.length,
                });
                return { model: builtModel, summary: summarizeBake(bundle) };
            } finally {
                playbackPausedRef.current = previousPaused;
                setIsPlaybackPaused(previousPaused);
                forceProjectionRefreshRef.current = true;
                forceNewProjectionFrameRef.current = true;
            }
        };

        return () => {
            disposed = true;
            setAnimationTimeRef.current = null;
            exportFrameRef.current = null;
            buildLive2dRef.current = null;
            if (segmentationTimer !== null) {
                window.clearTimeout(segmentationTimer);
            }
            clearDebugOverlay();
            if (targetMeshForAnimation) {
                try {
                    mmdHelper.remove(targetMeshForAnimation);
                } catch {
                    // ignore helper cleanup errors on dispose
                }
            }
            modelRef.current = null;
            leafMaterialMapRef.current.clear();
            webGpuProjector.releaseMeshes(projectionPartsRef.current.map((part) => part.mesh));
            projectionPartsRef.current = [];
            projectionMaskStateRef.current = null;
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('contextmenu', onContextMenu);
            controls.dispose();
            controlsRef.current = null;
            renderer.setAnimationLoop(null);
            if (model) disposeModelResources(model);
            renderer.dispose();
            mount.removeChild(renderer.domElement);
        };
    }, [initialModelUrl, initialModelName, resolveAssetUrl, resolveAnimationUrl]);

    const handleExportVideo = async (
        settings: ExportVideoSettings,
        onProgress: (completed: number, total: number) => void,
        signal: AbortSignal,
    ) => {
        const frameProvider = exportFrameRef.current;
        if (!frameProvider || assetStatus !== 'ready') {
            throw new Error('The model and projection are not ready for export.');
        }
        if (sourceBusy || operationBusyRef.current) throw new Error('Please wait for the current save, bake or export to finish.');
        operationBusyRef.current = true;
        setOperationBusy(true);
        onOperationStateChange?.(true);
        if (controlsRef.current) controlsRef.current.enabled = false;

        const previousPaused = playbackPausedRef.current;
        const previousTime = currentAnimationTimeRef.current;
        playbackPausedRef.current = true;
        setIsPlaybackPaused(true);
        try {
            await exportVideo(settings, frameProvider, onProgress, signal);
        } finally {
            setAnimationTimeRef.current?.(previousTime);
            playbackPausedRef.current = previousPaused;
            setIsPlaybackPaused(previousPaused);
            operationBusyRef.current = false;
            setOperationBusy(false);
            onOperationStateChange?.(false);
            if (controlsRef.current) controlsRef.current.enabled = true;
        }
    };

    const handleBuildLive2d = async (
        onProgress: (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void,
        textureScale: number,
    ): Promise<BakeSummary> => {
        const runner = buildLive2dRef.current;
        if (!runner || assetStatus !== 'ready') {
            throw new Error('The scene is not ready for building.');
        }
        if (sourceBusy || operationBusyRef.current) throw new Error('Please wait for the current save, bake or export to finish.');
        operationBusyRef.current = true;
        setOperationBusy(true);
        onOperationStateChange?.(true);
        if (controlsRef.current) controlsRef.current.enabled = false;
        try {
            const { model, summary } = await runner(onProgress, textureScale);
            setLive2dModel(model);
            return summary;
        } finally {
            operationBusyRef.current = false;
            setOperationBusy(false);
            onOperationStateChange?.(false);
            if (controlsRef.current) controlsRef.current.enabled = true;
        }
    };

    const baseRuntimeStatus: RuntimeStatus = gpuStatus === 'ready' ? assetStatus : gpuStatus;
    const requestedCpuBackend = projectionSettings.cpuRasterBackend ?? 'ts';
    const runtimeStatus: RuntimeStatus =
        baseRuntimeStatus !== 'ready' || requestedCpuBackend === 'ts' || wasmSnapshot.status === 'ready'
            ? baseRuntimeStatus
            : wasmSnapshot.status === 'timed-out'
              ? 'wasm-timed-out'
              : wasmSnapshot.status === 'failed'
                ? 'wasm-failed'
                : 'wasm-loading';

    return (
        <div className="app-shell">
            <PartPanel
                assetPanel={assetPanel}
                operationBusy={operationBusy}
                parts={parts}
                debugMaterials={debugMaterials}
                selectedPartId={selectedPartId}
                projectionSettings={projectionSettings}
                animationOptions={animationOptions ?? [...VMD_ANIMATION_OPTIONS]}
                selectedAnimation={selectedAnimation}
                isPlaybackPaused={isPlaybackPaused}
                frameStride={frameStride}
                onAnimationChange={(value) => {
                    if (operationBusyRef.current) return;
                    setSelectedAnimation(value);
                    onAnimationSelection?.(value);
                }}
                onTogglePlaybackPaused={() => setIsPlaybackPaused((current) => !current)}
                onStepBackwardStrideFrames={() => stepBackwardStrideFramesRef.current?.()}
                onStepBackwardSingleFrame={() => stepBackwardSingleFrameRef.current?.()}
                onStepForwardSingleFrame={() => stepForwardSingleFrameRef.current?.()}
                onStepForwardStrideFrames={() => stepForwardStrideFramesRef.current?.()}
                onFrameStrideChange={setFrameStride}
                onSelect={(value) => { if (!operationBusyRef.current) setSelectedPartId(value); }}
                onProjectionSettingsChange={(value) => { if (!operationBusyRef.current) setProjectionSettings(value); }}
                wasmSnapshot={wasmSnapshot}
                animationFrameCount={animationFrameCount}
                onExportVideo={handleExportVideo}
                onBuildLive2d={handleBuildLive2d}
                live2dModel={live2dModel}
                onImportLive2dModel={setLive2dModel}
            />
            <div className="viewport-pane">
                <div ref={mountRef} className="viewport" />
                {animationError && <div className="asset-animation-error" role="alert">{animationError}</div>}
            </div>
            <div ref={resultPaneRef} className="result-pane">
                <ProjectionOverlay ref={projectionOverlayRef} />
                {runtimeStatus !== 'ready' ? (
                    <div className="runtime-status" role="status">
                        {assetError || RUNTIME_STATUS_LABELS[runtimeStatus]}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export default App;
