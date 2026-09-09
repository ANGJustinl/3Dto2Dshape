import * as THREE from 'three';

/** MMD models face +Z. Fit a level frontal view rather than baking the orbit. */
export function frameFrontCamera(camera: THREE.PerspectiveCamera, root: THREE.Object3D): THREE.Vector3 {
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    if (box.isEmpty()) return center;
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distance = Math.max(size.y / 2, size.x / (2 * camera.aspect)) / tangent * 1.12 + size.z / 2;
    camera.up.set(0, 1, 0);
    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return center;
}
