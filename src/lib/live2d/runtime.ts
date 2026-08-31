import * as THREE from 'three';
import { createPoseEvaluator, type PoseEvaluator } from './keyforms';
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
const scratchScene = new THREE.Scene();

const scratchSceneFor = (meshes: THREE.Mesh[]): THREE.Scene => {
    scratchScene.clear();
    meshes.forEach((mesh) => scratchScene.add(mesh));
    return scratchScene;
};

const material0 = (meshes: THREE.Mesh[]): THREE.MeshBasicMaterial | undefined =>
    meshes[0]?.material as THREE.MeshBasicMaterial | undefined;

export class Live2dPreviewRuntime {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera: THREE.OrthographicCamera;
    private readonly evaluator: PoseEvaluator;
    private readonly neutralOrder: number[] = [];
    private readonly maskGroups: Array<{
        maskerMesh: THREE.Mesh;
        maskedMeshes: THREE.Mesh[];
        stencilWriteMaterial: THREE.MeshBasicMaterial;
        stencilTestMaterial: THREE.MeshBasicMaterial;
    }> = [];
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
            stencil: true,
        });
        this.renderer.setPixelRatio(1);
        // Canvas backing-store size, not clientWidth: offscreen A/B canvases
        // have no layout, and the attribute is authoritative here.
        this.renderer.setSize(canvas.width || 512, canvas.height || 512, false);
        this.renderer.setClearColor(0x000000, 0);

        const { width, height } = model.viewport;
        // Use the exact export viewport. build.ts already frames every
        // additive pose into this canvas, so preview and Cubism/VTS now share
        // identical composition instead of applying a second neutral-only fit.
        this.camera = new THREE.OrthographicCamera(
            0,
            width,
            0,
            height,
            0,
            10,
        );
        this.camera.position.set(0, 0, 1);
        this.camera.lookAt(0, 0, 0);

        this.drawables = model.drawables;
        (window as unknown as { __live2dRuntime?: unknown }).__live2dRuntime = this;
        this.outputs = model.drawables.map((drawable) => new Float32Array(drawable.vertexCount * 2));
        this.assignment = {} as ParamAssignment;
        this.neutralOrder.push(
            ...model.drawables
                .map((_drawable, index) => index)
                .sort((left, right) => model.drawables[left].renderOrder - model.drawables[right].renderOrder),
        );
        this.defaults = {} as ParamAssignment;
        model.params.forEach((param) => {
            this.assignment[param.id] = param.default;
            this.defaults[param.id] = param.default;
        });

        const neutralPositions = model.drawables.map((drawable) => drawable.neutralPositions);
        this.evaluator = createPoseEvaluator(model.drawables, neutralPositions, model.families);

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

        // Cubism masking groups: masked drawables clip to the union of their
        // maskers via the stencil buffer (mouth interior -> lip line).
        const maskerIds = new Set<string>();
        model.drawables.forEach((drawable) => (drawable.maskIds ?? []).forEach((id) => maskerIds.add(id)));
        maskerIds.forEach((maskerId) => {
            const maskerMesh = this.meshByDrawableId.get(maskerId);
            if (!maskerMesh) {
                return;
            }
            const maskedMeshes = model.drawables
                .filter((drawable) => (drawable.maskIds ?? []).includes(maskerId))
                .map((drawable) => this.meshByDrawableId.get(drawable.id))
                .filter((mesh): mesh is THREE.Mesh => mesh !== undefined);
            if (maskedMeshes.length === 0) {
                return;
            }
            const stencilWriteMaterial = (maskerMesh.material as THREE.MeshBasicMaterial).clone();
            stencilWriteMaterial.colorWrite = false;
            stencilWriteMaterial.stencilWrite = true;
            stencilWriteMaterial.stencilRef = 1;
            stencilWriteMaterial.stencilFunc = THREE.AlwaysStencilFunc;
            stencilWriteMaterial.stencilZPass = THREE.ReplaceStencilOp;
            const stencilTestMaterial = (material0(maskedMeshes))!.clone();
            stencilTestMaterial.stencilWrite = true;
            stencilTestMaterial.stencilRef = 1;
            stencilTestMaterial.stencilFunc = THREE.EqualStencilFunc;
            this.maskGroups.push({ maskerMesh, maskedMeshes, stencilWriteMaterial, stencilTestMaterial });
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

        // Constant neutral draw order at every pose. The neutral sequence
        // isolates each hair piece between non-hair drawables, so no
        // pose-driven reorder can avoid crossing a non-hair boundary
        // (bald head, bear over the chest); rigid displacement carries the
        // head-turn occlusion instead.
        this.neutralOrder.forEach((drawableIndex, rank) => {
            this.meshes[drawableIndex].renderOrder = rank;
        });

        if (this.maskGroups.length === 0) {
            this.renderer.render(this.scene, this.camera);
            return;
        }

        // Cubism masking: masked drawables render only inside their maskers'
        // opaque area (stencil buffer).
        const maskedSet = new Set<THREE.Mesh>();
        this.maskGroups.forEach((group) => group.maskedMeshes.forEach((mesh) => maskedSet.add(mesh)));
        const unmasked = this.scene.children.filter(
            (child): child is THREE.Mesh => child instanceof THREE.Mesh && !maskedSet.has(child),
        );
        unmasked.sort((left, right) => left.renderOrder - right.renderOrder);
        this.renderer.clear(true, true, true);
        this.renderer.render(
            unmasked.length === this.scene.children.length ? this.scene : scratchSceneFor(unmasked),
            this.camera,
        );
        this.maskGroups.forEach((group) => {
            const maskerMaterial = group.maskerMesh.material as THREE.MeshBasicMaterial;
            group.maskerMesh.material = group.stencilWriteMaterial;
            this.renderer.render(group.maskerMesh, this.camera);
            group.maskerMesh.material = maskerMaterial;
            group.maskedMeshes.forEach((mesh) => {
                const material = mesh.material as THREE.MeshBasicMaterial;
                mesh.material = group.stencilTestMaterial;
                this.renderer.render(mesh, this.camera);
                mesh.material = material;
            });
            this.renderer.render(group.maskerMesh, this.camera);
        });
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
