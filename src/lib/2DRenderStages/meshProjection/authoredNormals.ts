import * as THREE from 'three';

/** Match Three's skinnormal shader while retaining the artist's vertex normals. */
export const toAnimatedWorldNormals = (mesh: THREE.Mesh | THREE.SkinnedMesh) => {
    const normal = mesh.geometry.getAttribute('normal');
    if (!normal) return undefined;
    const output = new Float32Array(normal.count * 3);
    const world = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const skinIndex = mesh.geometry.getAttribute('skinIndex');
    const skinWeight = mesh.geometry.getAttribute('skinWeight');
    const skinned = mesh instanceof THREE.SkinnedMesh && skinIndex && skinWeight;
    const boneNormals = skinned ? mesh.skeleton.bones.map((_bone, index) => {
        const skin = new THREE.Matrix4().fromArray(mesh.skeleton.boneMatrices!, index * 16);
        skin.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
        return new THREE.Matrix3().multiplyMatrices(world, new THREE.Matrix3().setFromMatrix4(skin)).elements;
    }) : [];
    const vector = new THREE.Vector3();
    for (let i = 0; i < normal.count; i++) {
        const x = normal.getX(i), y = normal.getY(i), z = normal.getZ(i);
        let nx = 0, ny = 0, nz = 0;
        if (skinned) {
            for (let j = 0; j < 4; j++) {
                const weight = skinWeight.getComponent(i, j);
                if (!weight) continue;
                const m = boneNormals[skinIndex.getComponent(i, j)];
                nx += weight * (m[0] * x + m[3] * y + m[6] * z);
                ny += weight * (m[1] * x + m[4] * y + m[7] * z);
                nz += weight * (m[2] * x + m[5] * y + m[8] * z);
            }
            vector.set(nx, ny, nz).normalize();
        } else vector.set(x, y, z).applyMatrix3(world).normalize();
        output.set([vector.x, vector.y, vector.z], i * 3);
    }
    return output;
};
