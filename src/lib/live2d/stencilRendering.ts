import * as THREE from 'three';

type MaskGroup = {
    maskerMesh: THREE.Mesh;
    maskedMeshes: THREE.Mesh[];
    stencilWriteMaterial: THREE.MeshBasicMaterial;
};

/** Keep scene ownership, drawable order, and each drawable's own texture. */
export function renderMaskedMeshes(
    renderer: Pick<THREE.WebGLRenderer, 'autoClear' | 'clear' | 'clearStencil' | 'render'>,
    camera: THREE.Camera,
    orderedMeshes: THREE.Mesh[],
    groups: MaskGroup[],
) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
        renderer.clear(true, true, true);
        for (const mesh of orderedMeshes) {
            const masks = groups.filter((group) => group.maskedMeshes.includes(mesh));
            if (!masks.length) {
                renderer.render(mesh, camera);
                continue;
            }
            renderer.clearStencil();
            for (const group of masks) {
                const original = group.maskerMesh.material;
                group.stencilWriteMaterial.opacity = (original as THREE.MeshBasicMaterial).opacity;
                group.maskerMesh.material = group.stencilWriteMaterial;
                try {
                    renderer.render(group.maskerMesh, camera);
                } finally {
                    group.maskerMesh.material = original;
                }
            }
            const material = mesh.material as THREE.MeshBasicMaterial;
            const saved = {
                stencilWrite: material.stencilWrite,
                stencilRef: material.stencilRef,
                stencilFunc: material.stencilFunc,
            };
            material.stencilWrite = true;
            material.stencilRef = 1;
            material.stencilFunc = mesh.userData.invertedMask ? THREE.NotEqualStencilFunc : THREE.EqualStencilFunc;
            try {
                renderer.render(mesh, camera);
            } finally {
                Object.assign(material, saved);
            }
        }
    } finally {
        renderer.autoClear = autoClear;
    }
}
