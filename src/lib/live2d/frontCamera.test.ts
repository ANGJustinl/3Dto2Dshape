import * as THREE from 'three';
import { expect, it } from 'vitest';
import { frameFrontCamera } from './frontCamera';

it('resets yaw, pitch and roll and fits the model from the front', () => {
    const root = new THREE.Mesh(new THREE.BoxGeometry(8, 20, 4));
    root.position.set(3, 10, 1);
    const camera = new THREE.PerspectiveCamera(45, 1);
    camera.position.set(20, 40, 20);
    camera.up.set(1, 0, 0);
    const center = frameFrontCamera(camera, root);
    expect(camera.position.x).toBe(center.x);
    expect(camera.position.y).toBe(center.y);
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0,0,-1))).toBeLessThan(1e-6);
    for (const x of [-1,1]) for (const y of [-1,1]) {
        const p = new THREE.Vector3(center.x+x*4,center.y+y*10,center.z+2).project(camera);
        expect(Math.abs(p.x)).toBeLessThan(1);
        expect(Math.abs(p.y)).toBeLessThan(1);
    }
});
