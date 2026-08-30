import * as THREE from 'three';
import { createPoseEvaluator, createDepthEvaluator, type DepthEvaluator, type PoseEvaluator } from './keyforms';
import type { Live2dModel } from './model';
import type { FaceParamId, ParamAssignment } from './types';

/**
 * M4: interactive preview runtime. One textured mesh per drawable in an
 * orthographic scene whose coordinate system IS the bake viewport (y down),
 * so projected vertex positions map to screen space directly. Positions are
 * recomputed from the additive keyform evaluator on every param change; UVs
 * stay pinned to the neutral crop window, which is what makes the texture
 * follow the deformation.
 */
export class Live2dPreviewRuntime {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera: THREE.OrthographicCamera;
    private readonly evaluator: PoseEvaluator;
    private readonly depthEvaluator: DepthEvaluator | null = null;
    private readonly depthScratch: Float32Array;
    private readonly depthOrderIndices: number[] = [];
    private readonly drawables: Live2dModel['drawables'];
    private readonly outputs: Float32Array[];
    private readonly positionAttributes: THREE.BufferAttribute[] = [];
    private readonly meshes: THREE.Mesh[] = [];
    private readonly meshByDrawableId = new Map<string, THREE.Mesh>();
    private readonly assignment: ParamAssignment;
    private readonly defaults: ParamAssignment;

    constructor(canvas: HTMLCanvasElement, model: Live2dModel) {
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            alpha: true,
            antialias: true,
            preserveDrawingBuffer: true,
        });
        this.renderer.setPixelRatio(1);
        // Canvas backing-store size, not clientWidth: offscreen A/B canvases
        // have no layout, and the attribute is authoritative here.
        this.renderer.setSize(canvas.width || 512, canvas.height || 512, false);
        this.renderer.setClearColor(0x000000, 0);

        const { width, height } = model.viewport;
        // Fit the ortho window to the model's neutral bounds so the character
        // fills the canvas instead of floating in bake-view margins.
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        model.drawables.forEach((drawable) => {
            for (let v = 0; v < drawable.vertexCount; v += 1) {
                minX = Math.min(minX, drawable.neutralPositions[v * 2]);
                maxX = Math.max(maxX, drawable.neutralPositions[v * 2]);
                minY = Math.min(minY, drawable.neutralPositions[v * 2 + 1]);
                maxY = Math.max(maxY, drawable.neutralPositions[v * 2 + 1]);
            }
        });
        if (!Number.isFinite(minX)) {
            minX = 0;
            minY = 0;
            maxX = width;
            maxY = height;
        }
        const marginX = (maxX - minX) * 0.06;
        const marginY = (maxY - minY) * 0.06;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const halfExtent = Math.max(maxX - minX, maxY - minY) / 2 + Math.max(marginX, marginY);
        this.camera = new THREE.OrthographicCamera(
            centerX - halfExtent,
            centerX + halfExtent,
            centerY - halfExtent,
            centerY + halfExtent,
            0,
            10,
        );
        this.camera.position.set(0, 0, 1);
        this.camera.lookAt(0, 0, 0);

        this.drawables = model.drawables;
        this.outputs = model.drawables.map((drawable) => new Float32Array(drawable.vertexCount * 2));
        this.assignment = {} as ParamAssignment;
        this.defaults = {} as ParamAssignment;
        model.params.forEach((param) => {
            this.assignment[param.id] = param.default;
            this.defaults[param.id] = param.default;
        });

        const neutralPositions = model.drawables.map((drawable) => drawable.neutralPositions);
        this.evaluator = createPoseEvaluator(model.drawables, neutralPositions, model.families);
        this.depthScratch = new Float32Array(model.drawables.length);
        if (Object.keys(model.depthFamilies ?? {}).length > 0) {
            this.depthEvaluator = createDepthEvaluator(
                model.drawables.length,
                model.neutralDepths,
                model.depthFamilies,
            );
        }

        model.drawables.forEach((drawable) => {
            const positions = new Float32Array(drawable.vertexCount * 3);
            for (let v = 0; v < drawable.vertexCount; v += 1) {
                positions[v * 3] = drawable.neutralPositions[v * 2];
                positions[v * 3 + 1] = drawable.neutralPositions[v * 2 + 1];
                positions[v * 3 + 2] = 0;
            }
            const positionAttribute = new THREE.BufferAttribute(positions, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            const uvAttribute = new THREE.BufferAttribute(drawable.uvs, 2);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', positionAttribute);
            geometry.setAttribute('uv', uvAttribute);
            geometry.setIndex(new THREE.BufferAttribute(drawable.triangles, 1));

            const texture = new THREE.DataTexture(
                drawable.texture.rgba,
                drawable.texture.width,
                drawable.texture.height,
                THREE.RGBAFormat,
            );
            texture.colorSpace = THREE.SRGBColorSpace;
            // DataTexture defaults to Nearest filtering, which shreds detail
            // when the 1024px bake textures are minified into the preview.
            texture.magFilter = THREE.LinearFilter;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.generateMipmaps = true;
            texture.flipY = false;
            texture.needsUpdate = true;

            const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = drawable.renderOrder;
            mesh.frustumCulled = false;
            this.scene.add(mesh);
            this.meshByDrawableId.set(drawable.id, mesh);
            this.positionAttributes.push(positionAttribute);
            this.meshes.push(mesh);
        });

        this.render();
    }

    setParam(id: FaceParamId, value: number) {
        this.assignment[id] = value;
    }

    setAssignment(assignment: ParamAssignment) {
        Object.assign(this.assignment, assignment);
    }

    getAssignment(): ParamAssignment {
        return { ...this.assignment };
    }

    reset() {
        Object.assign(this.assignment, this.defaults);
        this.resetDrawableOpacities();
    }

    /** PartOpacity control: values outside [0,1] are clamped by the material. */
    setDrawableOpacity(drawableId: string, opacity: number) {
        const mesh = this.meshByDrawableId.get(drawableId);
        if (mesh) {
            (mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, Math.max(0, opacity));
        }
    }

    resetDrawableOpacities() {
        this.meshes.forEach((mesh) => {
            (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
        });
    }

    render() {
        this.evaluator.evaluate(this.assignment, this.outputs);
        this.drawables.forEach((drawable, index) => {
            const positions = this.positionAttributes[index].array as Float32Array;
            const output = this.outputs[index];
            for (let v = 0; v < drawable.vertexCount; v += 1) {
                positions[v * 3] = output[v * 2];
                positions[v * 3 + 1] = output[v * 2 + 1];
            }
            this.positionAttributes[index].needsUpdate = true;
        });

        // Dynamic draw order: re-rank by interpolated median depth so the
        // static-order occlusion flips resolve as the pose changes.
        if (this.depthEvaluator) {
            this.depthEvaluator.evaluate(this.assignment, this.depthScratch);
            this.depthOrderIndices.length = 0;
            for (let index = 0; index < this.drawables.length; index += 1) {
                this.depthOrderIndices.push(index);
            }
            this.depthOrderIndices.sort(
                (left, right) => this.depthScratch[right] - this.depthScratch[left],
            );
            this.depthOrderIndices.forEach((drawableIndex, rank) => {
                this.meshes[drawableIndex].renderOrder = rank;
            });
        }

        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.meshes.forEach((mesh) => {
            const material = mesh.material as THREE.MeshBasicMaterial;
            material.map?.dispose();
            material.dispose();
            mesh.geometry.dispose();
            this.scene.remove(mesh);
        });
        this.renderer.dispose();
    }
}
