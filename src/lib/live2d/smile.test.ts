import * as THREE from 'three';
import { expect, it } from 'vitest';
import { FACE_PARAM_DEFINITIONS, resolveFaceParams } from './paramMapping';

it('resolves a real smile morph and never substitutes a vowel or eye smile', () => {
    const mesh = new THREE.SkinnedMesh();
    mesh.bind(new THREE.Skeleton([]));
    mesh.morphTargetDictionary = { 'あ': 0, '笑い': 1, 'にやり': 2 };
    const definition = FACE_PARAM_DEFINITIONS.filter((d) => d.id === 'ParamMouthForm');
    expect(resolveFaceParams([mesh], definition).params[0].resolved?.morphIndex).toBe(2);
    delete mesh.morphTargetDictionary['にやり'];
    expect(resolveFaceParams([mesh], definition).params[0].resolved).toBeNull();
});
