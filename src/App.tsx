import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import ammoWasmScriptUrl from 'three/examples/jsm/libs/ammo.wasm.js?url';
import ammoWasmUrl from 'three/examples/jsm/libs/ammo.wasm.wasm?url';
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
    'model-error': 'Model failed to load. Check the external models directory.',
    'wasm-loading': 'Initializing CPU raster WASM…',
    'wasm-failed': 'WASM initialization failed. Choose TypeScript fallback or retry in Advanced settings.',
    'wasm-timed-out': 'WASM initialization timed out. Choose TypeScript fallback or retry in Advanced settings.',
};

const INITIAL_POSE_ANIMATION_VALUE = '__initial_pose__';
const ANIMATION_FRAME_SECONDS = 1 / 30;

type ExportFrameProvider = (frame: number) => Promise<ExportFrameCanvases>;

// Runtime assets are served from public/models. Keep the downloaded folder name
// encoded so the Chinese model directory remains a valid URL segment.
const MODEL_DIRECTORY = '可琳_by_绝区零_2bdf4e664d2349e13c899f884728ce53';
const MODEL_FILE = '可琳.pmx';
const MODEL_URL = `${import.meta.env.BASE_URL}models/${encodeURIComponent(MODEL_DIRECTORY)}/${encodeURIComponent(MODEL_FILE)}`;

const VMD_ANIMATION_OPTIONS = [
    {
        label: 'Initial Pose',
        value: INITIAL_POSE_ANIMATION_VALUE,
    },
    {
        label: 'Aerial',
        value: 'Aerial.vmd',
    },
    {
        label: 'wavefile_v2',
        value: 'wavefile_v2.vmd',
    },
] as const;

let ammoPromise: Promise<unknown> | null = null;

const ensureAmmo = async () => {
    const globalObject = globalThis as typeof globalThis & { Ammo?: unknown };
    if (typeof globalObject.Ammo !== 'undefined') {
        return globalObject.Ammo;
    }

    if (ammoPromise) {
        return ammoPromise;
    }

    ammoPromise = new Promise<unknown>((resolve, reject) => {
        const existingScript = document.querySelector<HTMLScriptElement>(
            `script[data-ammo-loader="true"]`,
        );

        globalObject.Ammo = {
            locateFile: (path: string) => (path.endsWith('.wasm') ? ammoWasmUrl : path),
        };

        const finalize = async () => {
            try {
                const ammoFactory = globalObject.Ammo as
                    | ((config?: { locateFile?: (path: string) => string }) => Promise<unknown>)
                    | { ready?: Promise<unknown> };

                if (typeof ammoFactory === 'function') {
                    const ammo = await ammoFactory({
                        locateFile: (path: string) => (path.endsWith('.wasm') ? ammoWasmUrl : path),
                    });
                    globalObject.Ammo = ammo;
                    resolve(ammo);
                    return;
                }

                if (ammoFactory && typeof ammoFactory === 'object' && ammoFactory.ready) {
                    const ammo = await ammoFactory.ready;
                    globalObject.Ammo = ammo;
                    resolve(ammo);
                    return;
                }

                reject(new Error('Ammo factory did not initialize.'));
            } catch (error) {
                reject(error);
            }
        };

        if (existingScript) {
            void finalize();
            return;
        }

        const script = document.createElement('script');
        script.src = ammoWasmScriptUrl;
        script.async = true;
        script.dataset.ammoLoader = 'true';
        script.onload = () => {
            void finalize();
        };
        script.onerror = () => {
            ammoPromise = null;
            reject(new Error('Failed to load ammo.wasm.js script.'));
        };
        document.head.appendChild(script);
    });

    return ammoPromise;
};

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

function App() {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const resultPaneRef = useRef<HTMLDivElement | null>(null);
    const modelRef = useRef<THREE.Object3D | null>(null);
    const projectionOverlayRef = useRef<ProjectionOverlayHandle | null>(null);
    const materialStateRef = useRef(new WeakMap<THREE.Material, MaterialState>());
    const leafMaterialMapRef = useRef(new Map<string, THREE.Material>());
    const projectionPartsRef = useRef<ProjectionPartSource[]>([]);
    const projectionMaskStateRef = useRef<ProjectionMaskState | null>(null);
    const projectionSettingsRef = useRef<ProjectionOverlaySettings>({
        enabled: true,
        styleMode: 'animationStable',
        simplifyEpsilon: 0,
        strokeWidth: 1.25,
        showContours: false,
        opacity: 1,
        minTriangleCount: 1,
        backgroundColor: '#FFA8A8',
        outlineColor: '#51443D',
        outlineOpacity: 0.72,
        shadowStrength: 0.38,
        highlightStrength: 0.24,
        shadowThreshold: -0.30,
        highlightThreshold: 0.62,
        lightDirection: [0.35, 0.8, 0.45],
        minShapeArea: 8,
        edgeRoughness: 0.35,
        edgeSmoothing: 'soft',
        enableComposition: false,
        enableShapeTracking: false,
        enableEdgeDistortion: false,
        compositionMode: 'vector',
        boundaryGuard: 'outerDepthNormal',
        depthMergeThreshold: 0.035,
        normalMergeThreshold: 0.61,
        gapMergeThreshold: 1.5,
        temporalStability: 0.78,
        globalShapeBudget: 96,
        focusShapeBudgets: {
            focal: 40,
            support: 28,
            abstract: 12,
        },
        mergeColorThreshold: 0.12,
        partOverrides: {},
        cpuRasterBackend: 'auto',
    });
    const visibleLeafIdsRef = useRef<Set<string> | null>(null);
    const selectedAnimationRef = useRef<string>(VMD_ANIMATION_OPTIONS[0].value);
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
        VMD_ANIMATION_OPTIONS[0].value,
    );
    const [animationFrameCount, setAnimationFrameCount] = useState(1);
    const [frameStride, setFrameStride] = useState(2);
    const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
    const [live2dModel, setLive2dModel] = useState<Live2dModel | null>(null);
    const [gpuStatus, setGpuStatus] = useState<GpuStatus>('checking');
    const [assetStatus, setAssetStatus] = useState<AssetStatus>('loading-model');
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
        controls.enableDamping = true;
        controls.dampingFactor = 0.5;
        controls.target.set(0, 10, 0);
        controls.minDistance = 8;
        controls.maxDistance = 60;
        controls.enablePan = false;

        const loader = new MMDLoader();
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
                if (disposed) {
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

            if (selectedAnimationRef.current === INITIAL_POSE_ANIMATION_VALUE) {
                targetMesh.pose();
                targetMesh.updateMatrixWorld(true);
                modelRef.current?.updateMatrixWorld(true);
                return;
            }

            loader.loadAnimation(
                `${import.meta.env.BASE_URL}models/vmd/${encodeURIComponent(selectedAnimationRef.current)}`,
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
                    if (currentToken !== animationLoadToken) {
                        return;
                    }
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
            const segmentation = splitModelParts(targetModel, 'Corin');
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
            setAssetStatus('loading-textures');
            const attempt = () => {
                if (disposed) {
                    return;
                }

                if (areModelTexturesReady(targetModel)) {
                    applySegmentation(targetModel);
                    return;
                }

                segmentationTimer = window.setTimeout(attempt, 120);
            };

            attempt();
        };

        loader.load(
            MODEL_URL,
            (loadedModel: THREE.Object3D) => {
                if (disposed) {
                    return;
                }

                model = loadedModel;
                setAssetStatus('loading-textures');
                modelRef.current = loadedModel;
                const currentModel = loadedModel;
                const box = new THREE.Box3().setFromObject(currentModel);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());

                currentModel.position.sub(center);
                currentModel.position.y += size.y * 0.5;

                scene.add(currentModel);
                scheduleSegmentation(currentModel);
                controls.target.set(0, size.y * 0.45, 0);
                camera.position.set(size.x * 0.7, size.y * 0.75, size.z * 2.6 + 8);
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
                setAssetStatus('model-error');
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
            const controlsChanged = controls.update();
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
                    : projectionFrameId;
                submittedProjectionTick = projectionTick;
                forceProjectionRefreshRef.current = false;
                forceNewProjectionFrameRef.current = false;
                if (!reuseProjectionFrame) {
                    lastSubmittedProjectionFrameId = projectionFrameId;
                    webGpuProjector.requestFrame(
                        projectionPartsRef.current,
                        camera,
                        resultWidth,
                        resultHeight,
                        renderFrameId,
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
            const TEXTURE_FRAME_ID_BASE = 2_000_000;
            const renderDrawable2D = async (
                leafIds: string[],
                isoCamera: THREE.PerspectiveCamera,
                viewport: { width: number; height: number },
            ): Promise<IsolatedRenderResult | null> => {
                try {
                    if (!neutralFrame) {
                        webGpuProjector.requestFrame(bakeParts, isoCamera, viewport.width, viewport.height, TEXTURE_FRAME_ID_BASE);
                        const ready = await webGpuProjector.waitForFrame(TEXTURE_FRAME_ID_BASE);
                        if (!ready) {
                            return null;
                        }
                        neutralFrame = webGpuProjector.getFrame(TEXTURE_FRAME_ID_BASE);
                        if (!neutralFrame) {
                            return null;
                        }
                    }

                    const settings = { ...projectionSettingsRef.current };
                    const shaped = await shapeProjectedParts(
                        bakeParts,
                        maskState,
                        settings,
                        new Set(leafIds),
                        neutralFrame,
                    );
                    if (!shaped || shaped.shapes.length === 0) {
                        return null;
                    }

                    const composedShapes = settings.enableComposition
                        ? composeProjectedShapes(
                              shaped.shapes,
                              maskState.sharedChains,
                              settings,
                              viewport.width,
                              viewport.height,
                          )
                        : shaped.shapes;
                    const modeDefaults = getStyleModeDefaults(settings.styleMode);
                    const filteredShapes = filterSmallProjectedPartShapes(
                        composedShapes,
                        settings.minShapeArea * modeDefaults.minShapeAreaScale,
                        settings.enableComposition ? { focal: 0.05, support: 1, abstract: 1.65 } : {},
                        settings.enableComposition,
                    );
                    if (filteredShapes.length === 0) {
                        return null;
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
                    modelName: 'Corin',
                    renderDrawable2D,
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
            projectionPartsRef.current = [];
            projectionMaskStateRef.current = null;
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('contextmenu', onContextMenu);
            controls.dispose();
            renderer.dispose();
            mount.removeChild(renderer.domElement);
        };
    }, []);

    const handleExportVideo = async (
        settings: ExportVideoSettings,
        onProgress: (completed: number, total: number) => void,
        signal: AbortSignal,
    ) => {
        const frameProvider = exportFrameRef.current;
        if (!frameProvider) {
            throw new Error('The model and projection are not ready for export.');
        }

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
        }
    };

    const handleBuildLive2d = async (
        onProgress: (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void,
        textureScale: number,
    ): Promise<BakeSummary> => {
        const runner = buildLive2dRef.current;
        if (!runner) {
            throw new Error('The scene is not ready for building.');
        }
        const { model, summary } = await runner(onProgress, textureScale);
        setLive2dModel(model);
        return summary;
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
                parts={parts}
                debugMaterials={debugMaterials}
                selectedPartId={selectedPartId}
                projectionSettings={projectionSettings}
                animationOptions={[...VMD_ANIMATION_OPTIONS]}
                selectedAnimation={selectedAnimation}
                isPlaybackPaused={isPlaybackPaused}
                frameStride={frameStride}
                onAnimationChange={setSelectedAnimation}
                onTogglePlaybackPaused={() => setIsPlaybackPaused((current) => !current)}
                onStepBackwardStrideFrames={() => stepBackwardStrideFramesRef.current?.()}
                onStepBackwardSingleFrame={() => stepBackwardSingleFrameRef.current?.()}
                onStepForwardSingleFrame={() => stepForwardSingleFrameRef.current?.()}
                onStepForwardStrideFrames={() => stepForwardStrideFramesRef.current?.()}
                onFrameStrideChange={setFrameStride}
                onSelect={setSelectedPartId}
                onProjectionSettingsChange={setProjectionSettings}
                wasmSnapshot={wasmSnapshot}
                animationFrameCount={animationFrameCount}
                onExportVideo={handleExportVideo}
                onBuildLive2d={handleBuildLive2d}
                live2dModel={live2dModel}
                onImportLive2dModel={setLive2dModel}
            />
            <div className="viewport-pane">
                <div ref={mountRef} className="viewport" />
            </div>
            <div ref={resultPaneRef} className="result-pane">
                <ProjectionOverlay ref={projectionOverlayRef} />
                {runtimeStatus !== 'ready' ? (
                    <div className="runtime-status" role="status">
                        {RUNTIME_STATUS_LABELS[runtimeStatus]}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export default App;
