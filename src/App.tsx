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
import { getWebGpuScreenProjector } from './lib/2DRenderStages/meshProjection/projector';
import { getSharedWebGpuContext } from './lib/webgpuShared';

type MaterialState = {
    visible: boolean;
};

type GpuStatus = 'checking' | 'ready' | 'webgpu-unavailable' | 'webgpu-error';
type AssetStatus = 'loading-model' | 'loading-textures' | 'ready' | 'model-error';
type RuntimeStatus = GpuStatus | AssetStatus;

const RUNTIME_STATUS_LABELS: Record<RuntimeStatus, string> = {
    checking: 'Checking WebGPU…',
    'webgpu-unavailable': 'WebGPU is unavailable. Use a compatible browser for the 2D view.',
    'webgpu-error': 'WebGPU initialization failed. Check browser permissions or GPU support.',
    'loading-model': 'Loading PMX model…',
    'loading-textures': 'Waiting for model textures…',
    ready: 'Ready',
    'model-error': 'Model failed to load. Check the external models directory.',
};

const INITIAL_POSE_ANIMATION_VALUE = '__initial_pose__';
const ANIMATION_FRAME_SECONDS = 1 / 30;

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
        simplifyEpsilon: 4,
        strokeWidth: 1.25,
        showContours: false,
        opacity: 1,
        minTriangleCount: 1,
        backgroundColor: '#FFFDF8',
        outlineColor: '#51443D',
        outlineOpacity: 0.72,
        shadowStrength: 0.38,
        highlightStrength: 0.24,
        shadowThreshold: 0.08,
        highlightThreshold: 0.62,
        lightDirection: [0.35, 0.8, 0.45],
        minShapeArea: 8,
        edgeRoughness: 0.35,
        edgeSmoothing: 'soft',
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
    const currentAnimationTimeRef = useRef(0);
    const currentAnimationDurationRef = useRef(0);
    const [parts, setParts] = useState<PartNode[]>([]);
    const [debugMaterials, setDebugMaterials] = useState<MaterialDebugInfo[]>([]);
    const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
    const [projectionSettings, setProjectionSettings] = useState<ProjectionOverlaySettings>(
        projectionSettingsRef.current,
    );
    const [selectedAnimation, setSelectedAnimation] = useState<string>(
        VMD_ANIMATION_OPTIONS[0].value,
    );
    const [frameStride, setFrameStride] = useState(2);
    const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
    const [gpuStatus, setGpuStatus] = useState<GpuStatus>('checking');
    const [assetStatus, setAssetStatus] = useState<AssetStatus>('loading-model');

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
            forceProjectionRefreshRef.current = true;

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
            controls.update();
            renderer.render(scene, camera);
            const resultPane = resultPaneRef.current;
            const resultWidth = resultPane?.clientWidth ?? 0;
            const resultHeight = resultPane?.clientHeight ?? 0;
            projectionFrameId += 1;
            const currentStride = Math.max(1, Math.floor(frameStrideRef.current));
            const projectionTick = Math.floor((projectionFrameId - 1) / currentStride);
            const shouldSubmitProjection =
                projectionTick !== submittedProjectionTick || forceProjectionRefreshRef.current;

            if (shouldSubmitProjection && projectionMaskStateRef.current) {
                submittedProjectionTick = projectionTick;
                forceProjectionRefreshRef.current = false;
                webGpuProjector.requestFrame(
                    projectionPartsRef.current,
                    camera,
                    resultWidth,
                    resultHeight,
                    projectionFrameId,
                );
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
                    projectionFrameId,
                );
            }
        };

        window.addEventListener('resize', onResize);
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('contextmenu', onContextMenu);
        animate();

        return () => {
            disposed = true;
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

    const runtimeStatus: RuntimeStatus = gpuStatus === 'ready' ? assetStatus : gpuStatus;

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
